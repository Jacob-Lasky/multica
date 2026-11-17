package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/auth"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// TestAuth_PATWithoutCacheThrottlesLastUsed is the JAKE-591 regression:
// with no PAT cache (no Redis), every request used to UPDATE the token's
// last_used_at, so one shared daemon token queued enough writes on one row
// to drain the connection pool. Requests after the first in a TTL window
// must leave last_used_at alone.
func TestAuth_PATWithoutCacheThrottlesLastUsed(t *testing.T) {
	pool := openPool(t)
	defer pool.Close()
	ctx := context.Background()

	var userID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO "user" (name, email) VALUES ('jake-591', 'jake-591-' || gen_random_uuid() || '@example.test')
		RETURNING id::text`).Scan(&userID); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	token, err := auth.GeneratePATToken()
	if err != nil {
		t.Fatalf("generate pat: %v", err)
	}
	var patID string
	if err := pool.QueryRow(ctx, `
		INSERT INTO personal_access_token (user_id, name, token_hash, token_prefix)
		VALUES ($1, 'jake-591', $2, $3) RETURNING id::text`,
		userID, auth.HashToken(token), token[:12]).Scan(&patID); err != nil {
		t.Fatalf("insert pat: %v", err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), `DELETE FROM personal_access_token WHERE id = $1`, patID)
		pool.Exec(context.Background(), `DELETE FROM "user" WHERE id = $1`, userID)
	})

	handler := Auth(db.New(pool), nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	do := func() {
		req := httptest.NewRequest("GET", "/api/me", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("PAT request: got %d, want 200", w.Code)
		}
	}
	lastUsed := func() *time.Time {
		var ts *time.Time
		if err := pool.QueryRow(ctx, `SELECT last_used_at FROM personal_access_token WHERE id = $1`, patID).Scan(&ts); err != nil {
			t.Fatalf("read last_used_at: %v", err)
		}
		return ts
	}

	do()
	deadline := time.Now().Add(5 * time.Second)
	for lastUsed() == nil {
		if time.Now().After(deadline) {
			t.Fatal("first PAT request never wrote last_used_at")
		}
		time.Sleep(20 * time.Millisecond)
	}

	sentinel := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `UPDATE personal_access_token SET last_used_at = $2 WHERE id = $1`, patID, sentinel); err != nil {
		t.Fatalf("reset last_used_at: %v", err)
	}
	for i := 0; i < 20; i++ {
		do()
	}
	time.Sleep(500 * time.Millisecond)
	if got := lastUsed(); got == nil || !got.Equal(sentinel) {
		t.Fatalf("later requests in the TTL window rewrote last_used_at: got %v, want %v", got, sentinel)
	}
}
