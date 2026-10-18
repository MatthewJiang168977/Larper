package platform

import "testing"

func TestPoolConfigNamesTheService(t *testing.T) {
	cfg, err := PoolConfig("postgres://u:p@localhost:5432/larper", "outbox-relay")
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.ConnConfig.RuntimeParams["application_name"]; got != "outbox-relay" {
		t.Fatalf("application_name = %q, want outbox-relay", got)
	}
}

func TestPoolConfigKeepsAnExplicitName(t *testing.T) {
	cfg, err := PoolConfig("postgres://u:p@localhost:5432/larper?application_name=custom", "outbox-relay")
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.ConnConfig.RuntimeParams["application_name"]; got != "custom" {
		t.Fatalf("application_name = %q, want custom", got)
	}
}
