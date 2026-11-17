package auth

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func testUUID(b byte) pgtype.UUID {
	return pgtype.UUID{Bytes: [16]byte{b}, Valid: true}
}

func TestPATLastUsedThrottle_ConcurrentRequestsWriteOnce(t *testing.T) {
	th := NewPATLastUsedThrottle(time.Minute)
	id := testUUID(1)

	var allowed atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if th.Allow(id) {
				allowed.Add(1)
			}
		}()
	}
	wg.Wait()
	if got := allowed.Load(); got != 1 {
		t.Fatalf("100 concurrent requests for one token: %d writes allowed, want 1", got)
	}
}

func TestPATLastUsedThrottle_IntervalAndTokens(t *testing.T) {
	now := time.Date(2026, 11, 17, 1, 13, 0, 0, time.UTC)
	th := NewPATLastUsedThrottle(time.Minute)
	th.now = func() time.Time { return now }

	a, b := testUUID(1), testUUID(2)
	if !th.Allow(a) {
		t.Fatal("first write for a token must be allowed")
	}
	if !th.Allow(b) {
		t.Fatal("another token must not be throttled by the first")
	}
	now = now.Add(59 * time.Second)
	if th.Allow(a) {
		t.Fatal("write inside the interval must be refused")
	}
	now = now.Add(time.Second)
	if !th.Allow(a) {
		t.Fatal("write once the interval has passed must be allowed")
	}
}

func TestPATLastUsedThrottle_PrunesStaleEntries(t *testing.T) {
	now := time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC)
	th := NewPATLastUsedThrottle(time.Minute)
	th.now = func() time.Time { return now }
	for i := 0; i < patLastUsedPruneAt; i++ {
		th.Allow(pgtype.UUID{Bytes: [16]byte{byte(i), byte(i >> 8)}, Valid: true})
	}
	now = now.Add(2 * time.Minute)
	th.Allow(testUUID(255))
	if n := len(th.last); n != 1 {
		t.Fatalf("map holds %d entries after prune, want 1", n)
	}
}
