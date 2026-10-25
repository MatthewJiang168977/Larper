package main

import "testing"

func TestParseBox(t *testing.T) {
	b, err := parseBox("-74.26, 40.49,-73.70,40.92")
	if err != nil || b.MinLng != -74.26 || b.MinLat != 40.49 || b.MaxLng != -73.70 || b.MaxLat != 40.92 {
		t.Fatalf("got %+v, %v", b, err)
	}
	for _, bad := range []string{"", "1,2,3", "a,b,c,d", "-73.70,40.49,-74.26,40.92", "0,0,200,1"} {
		if _, err := parseBox(bad); err == nil {
			t.Errorf("%q: accepted", bad)
		}
	}
}
