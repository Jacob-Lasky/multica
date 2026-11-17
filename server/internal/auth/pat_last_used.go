package auth

import (
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// PATLastUsedThrottle limits personal_access_token.last_used_at writes to
// one per token per interval inside this process.
//
// DO NOT rely on PATCache alone for this. PATCache is nil when the server
// runs without Redis, and then every PAT-authenticated request misses the
// cache and spawns its own UPDATE of the same row. A daemon and its agents
// share one PAT, so those updates queue on one row lock; when a commit
// stalls they hold every pool connection and unrelated requests fail
// (/readyz 503, task supplement claims 500). The throttle keeps the write
// at the once-per-TTL rate the cache gives, with or without Redis.
type PATLastUsedThrottle struct {
	interval time.Duration
	now      func() time.Time

	mu   sync.Mutex
	last map[[16]byte]time.Time
}

// patLastUsedPruneAt bounds the map: once it holds this many tokens,
// entries older than the interval are dropped on the next write.
const patLastUsedPruneAt = 1024

func NewPATLastUsedThrottle(interval time.Duration) *PATLastUsedThrottle {
	return &PATLastUsedThrottle{
		interval: interval,
		now:      time.Now,
		last:     make(map[[16]byte]time.Time),
	}
}

// Allow reports whether the caller should write last_used_at for id now,
// and records the write when it says yes.
func (t *PATLastUsedThrottle) Allow(id pgtype.UUID) bool {
	now := t.now()
	t.mu.Lock()
	defer t.mu.Unlock()
	if prev, ok := t.last[id.Bytes]; ok && now.Sub(prev) < t.interval {
		return false
	}
	if len(t.last) >= patLastUsedPruneAt {
		for k, v := range t.last {
			if now.Sub(v) >= t.interval {
				delete(t.last, k)
			}
		}
	}
	t.last[id.Bytes] = now
	return true
}

// PATLastUsed is the process-wide throttle shared by every PAT auth path
// (HTTP, daemon, WebSocket), at the same rate as the PAT cache TTL.
var PATLastUsed = NewPATLastUsedThrottle(AuthCacheTTL)
