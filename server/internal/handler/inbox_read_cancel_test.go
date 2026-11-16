package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/middleware"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// abortOnQuery runs every statement on the test pool, except the one named
// target: before that one it cancels the request, as a browser does when it
// aborts a superseded inbox fetch, so pgx sees a cancelled context mid-request.
type abortOnQuery struct {
	db.DBTX
	target string
	abort  context.CancelFunc
}

func (q abortOnQuery) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.Contains(sql, "-- name: "+q.target+" ") {
		q.abort()
	}
	return q.DBTX.Query(ctx, sql, args...)
}

// A client that aborts an inbox read mid-query (the web client's fetch carries
// an AbortSignal) is leaving, not hitting a server fault: answer 499, not 500.
func TestInboxReadAbortedByClientIsNot500(t *testing.T) {
	ws := dbfx.Workspace(t, "Aborted inbox read", "inbox-abort-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	cases := []struct {
		query, path string
		handler     func(*Handler) http.HandlerFunc
	}{
		{"ListArchivedInboxPage", "/api/inbox/archived/page", func(h *Handler) http.HandlerFunc { return h.ListArchivedInboxPage }},
		{"ArchivedInboxFacets", "/api/inbox/archived/facets", func(h *Handler) http.HandlerFunc { return h.GetArchivedInboxFacets }},
	}
	for _, tc := range cases {
		t.Run(tc.query, func(t *testing.T) {
			ctx, abort := context.WithCancel(context.Background())
			defer abort()
			h := *testHandler
			h.Queries = db.New(abortOnQuery{DBTX: testPool, target: tc.query, abort: abort})
			req := inboxRequest(http.MethodGet, tc.path, ws).WithContext(ctx)
			testutil.Call(t, inboxWorkspaceHandler(tc.handler(&h)), req).Want(middleware.StatusClientClosedRequest)
		})
	}
}

// The 499 is only for a request its client abandoned. A failure while the
// client is still waiting stays a 500, cancellation-shaped or not.
func TestWriteInboxReadErrorKeepsRealFailures500(t *testing.T) {
	live := httptest.NewRequest(http.MethodGet, "/api/inbox", nil)
	for _, err := range []error{errors.New("connection refused"), context.Canceled} {
		w := httptest.NewRecorder()
		writeInboxReadError(w, live, err, "failed to list inbox")
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("live request, %v: got %d, want 500", err, w.Code)
		}
	}
	ctx, abort := context.WithCancel(context.Background())
	abort()
	w := httptest.NewRecorder()
	writeInboxReadError(w, live.WithContext(ctx), errors.New("connection refused"), "failed to list inbox")
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("aborted request, unrelated error: got %d, want 500", w.Code)
	}
}
