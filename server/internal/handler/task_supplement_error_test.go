package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/middleware"
)

// A daemon that abandons a supplement claim or acknowledgement (its run ended,
// its per-request deadline hit) is leaving, not hitting a server fault: answer
// 499, which the request logger records at Info instead of as an error.
// Anything else, including a cancellation-shaped error on a live request,
// stays a 500 (JAKE-1155).
func TestWriteTaskSupplementError(t *testing.T) {
	path := "/api/daemon/tasks/00000000-0000-0000-0000-000000000001/supplements/claim"
	live := httptest.NewRequest(http.MethodPost, path, nil)
	ctx, abort := context.WithCancel(context.Background())
	abort()
	aborted := live.WithContext(ctx)

	cases := []struct {
		name string
		req  *http.Request
		err  error
		want int
	}{
		{"aborted request, cancelled query", aborted, context.Canceled, middleware.StatusClientClosedRequest},
		{"aborted request, unrelated error", aborted, errors.New("connection refused"), http.StatusInternalServerError},
		{"live request, cancelled query", live, context.Canceled, http.StatusInternalServerError},
		{"live request, real failure", live, errors.New("connection refused"), http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			writeTaskSupplementError(w, tc.req, tc.err, "failed to claim additional message")
			if w.Code != tc.want {
				t.Fatalf("got %d, want %d", w.Code, tc.want)
			}
		})
	}
}
