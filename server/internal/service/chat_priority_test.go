package service

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/attribution"
)

func TestChatTaskPriorityRanksDirectHumanAboveIssueWork(t *testing.T) {
	human := chatTaskPriority(pgtype.Text{String: string(attribution.SourceDirectHuman), Valid: true})
	if human <= priorityToInt("urgent") {
		t.Fatalf("direct human chat priority %d must exceed urgent issue priority %d", human, priorityToInt("urgent"))
	}
	for _, source := range []pgtype.Text{{}, {String: "delegated", Valid: true}, {String: "system", Valid: true}} {
		if got := chatTaskPriority(source); got != priorityToInt("medium") {
			t.Fatalf("chatTaskPriority(%+v) = %d, want medium %d", source, got, priorityToInt("medium"))
		}
	}
}
