// Package taxonomy maps Overture places onto Larper's niche tags and turns them
// into fixed-slot vectors (see taxonomy.yaml for the rules).
package taxonomy

import (
	_ "embed"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"
)

//go:embed taxonomy.yaml
var embedded []byte

type tagDef struct {
	ID         int      `yaml:"id"`
	Tag        string   `yaml:"tag"`
	Categories []string `yaml:"categories"`
	Keywords   []string `yaml:"keywords"`
	Weight     *float64 `yaml:"weight"`
}

type file struct {
	Version int      `yaml:"version"`
	Dims    int      `yaml:"dims"`
	Roots   []string `yaml:"roots"`
	Tags    []tagDef `yaml:"tags"`
}

type rule struct {
	slot   int
	tag    string
	weight float64
}

type Taxonomy struct {
	Version  int
	Dims     int
	roots    map[string]bool
	byCat    map[string][]rule
	keywords []kwRule
	names    map[int]string
}

type kwRule struct {
	padded string // " normalized keyword "
	rule
}

// Place is the subset of an Overture place the taxonomy looks at.
type Place struct {
	Name       string
	Hierarchy  []string // root first, e.g. [food_and_drink bar cocktail_bar]
	Alternates []string
}

// Result is what a place maps to. Vec is L2-normalized; nil when no tag fired.
type Result struct {
	Tags []string
	Vec  []float32
}

// Default returns the taxonomy compiled into the binary.
func Default() (*Taxonomy, error) { return Parse(embedded) }

func Parse(b []byte) (*Taxonomy, error) {
	var f file
	if err := yaml.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("taxonomy: %w", err)
	}
	t := &Taxonomy{
		Version: f.Version, Dims: f.Dims,
		roots: map[string]bool{}, byCat: map[string][]rule{}, names: map[int]string{},
	}
	for _, r := range f.Roots {
		t.roots[r] = true
	}
	seenTag := map[string]bool{}
	for _, d := range f.Tags {
		if d.ID < 0 || d.ID >= f.Dims {
			return nil, fmt.Errorf("taxonomy: tag %q slot %d out of range [0,%d)", d.Tag, d.ID, f.Dims)
		}
		if _, dup := t.names[d.ID]; dup {
			return nil, fmt.Errorf("taxonomy: slot %d used twice", d.ID)
		}
		if seenTag[d.Tag] {
			return nil, fmt.Errorf("taxonomy: tag %q defined twice", d.Tag)
		}
		if len(d.Categories) == 0 && len(d.Keywords) == 0 {
			return nil, fmt.Errorf("taxonomy: tag %q has no categories or keywords", d.Tag)
		}
		t.names[d.ID] = d.Tag
		seenTag[d.Tag] = true
		r := rule{slot: d.ID, tag: d.Tag, weight: 1}
		if d.Weight != nil {
			r.weight = *d.Weight
		}
		for _, c := range d.Categories {
			t.byCat[c] = append(t.byCat[c], r)
		}
		for _, k := range d.Keywords {
			t.keywords = append(t.keywords, kwRule{padded: " " + normalize(k) + " ", rule: r})
		}
	}
	return t, nil
}

// Tag maps one place. A tag fires at most once, at its highest matching weight.
func (t *Taxonomy) Tag(p Place) Result {
	hit := map[int]rule{}
	add := func(r rule) {
		if cur, ok := hit[r.slot]; !ok || r.weight > cur.weight {
			hit[r.slot] = r
		}
	}
	for _, c := range p.Hierarchy {
		for _, r := range t.byCat[c] {
			add(r)
		}
	}
	// Alternate categories are weaker evidence than the primary path.
	for _, c := range p.Alternates {
		for _, r := range t.byCat[c] {
			r.weight *= 0.5
			add(r)
		}
	}
	if len(p.Hierarchy) > 0 && t.roots[p.Hierarchy[0]] {
		name := " " + normalize(p.Name) + " "
		for _, k := range t.keywords {
			if strings.Contains(name, k.padded) {
				add(k.rule)
			}
		}
	}
	if len(hit) == 0 {
		return Result{}
	}

	vec := make([]float32, t.Dims)
	var norm float64
	tags := make([]string, 0, len(hit))
	for slot, r := range hit {
		vec[slot] = float32(r.weight)
		norm += r.weight * r.weight
		tags = append(tags, r.tag)
	}
	norm = math.Sqrt(norm)
	for i := range vec {
		vec[i] = float32(float64(vec[i]) / norm)
	}
	sort.Strings(tags)
	return Result{Tags: tags, Vec: vec}
}

// TagName returns the tag that owns a slot ("" if the slot is free).
func (t *Taxonomy) TagName(slot int) string { return t.names[slot] }

// ChainKey identifies "the same business" across locations so the indie score can
// count them. Brand and name share one key space, because Overture only fills
// brand on some locations of a chain ("Dunkin'" with a brand and without must
// match). Number-only words are dropped so "Starbucks #123" joins "Starbucks".
func ChainKey(name, brand string) string {
	s := name
	if brand != "" {
		s = brand
	}
	words := strings.Fields(normalize(s))
	kept := words[:0]
	for _, w := range words {
		if strings.TrimFunc(w, unicode.IsDigit) != "" {
			kept = append(kept, w)
		}
	}
	return strings.Join(kept, " ")
}

// VectorLiteral formats a vector the way pgvector parses it: [0.1,0,...].
func VectorLiteral(v []float32) string {
	var b strings.Builder
	b.Grow(len(v) * 4)
	b.WriteByte('[')
	for i, x := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(x), 'g', 6, 32))
	}
	b.WriteByte(']')
	return b.String()
}

// normalize lowercases and turns every run of non-letters/digits into one space,
// so keyword matching works on whole words: "Hi-Fi Bar" -> "hi fi bar".
func normalize(s string) string {
	var b strings.Builder
	space := true
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			space = false
		} else if !space {
			b.WriteByte(' ')
			space = true
		}
	}
	return strings.TrimSpace(b.String())
}
