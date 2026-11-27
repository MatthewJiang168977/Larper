"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OSButton } from "@/components/larper-os/primitives";
import { ApiError, describeError, useApi } from "@/lib/api";
import { webUrl } from "@/lib/web-url";
import { MAX_NOTE_LENGTH, type CurationList, type CurationPlace, type Fact, type Verdict } from "./api";
import "./curation.css";

const VERDICTS: { kind: Verdict; key: string; label: string }[] = [
  { kind: "great", key: "g", label: "great" },
  { kind: "verified", key: "v", label: "verified" },
  { kind: "closed", key: "c", label: "closed" },
  { kind: "bad_fit", key: "b", label: "bad fit" },
];
const VERDICT_LABEL = Object.fromEntries(VERDICTS.map((v) => [v.kind, v.label])) as Record<Verdict, string>;
const REPORT_LABEL = { was_open: "was open", wasnt_open: "wasn't open", skipped_closed: "skipped: closed" };

type Editing = "hours" | "note" | null;

const day = (iso: string) => iso.slice(0, 10);
/** Reviewed: a verdict that still stands (a positive one expires after 90 days). */
// A suspended place needs another look whatever was said before.
const reviewed = (p: CurationPlace) => p.verdict !== null && !p.verdict.expired && !p.reliability?.suspended;

export function CurationPage() {
  const api = useApi();
  const [area, setArea] = useState("east-village");
  const [list, setList] = useState<CurationList | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const [todoOnly, setTodoOnly] = useState(true);
  const [current, setCurrent] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);

  useEffect(() => {
    let live = true;
    api<CurationList>(`/admin/places?area=${encodeURIComponent(area)}`).then(
      (l) => {
        if (!live) return;
        setList(l);
        setCurrent((l.places.find((p) => !reviewed(p)) ?? l.places[0])?.id ?? null);
      },
      (e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setError(describeError(e));
      },
    );
    return () => {
      live = false;
    };
  }, [api, area, tries]);

  // Back to "loading" before another area, or another try, is fetched.
  const clear = () => {
    setList(null);
    setError(null);
    setEditing(null);
  };

  // The place in hand stays listed after its verdict, so it can be corrected or annotated.
  const places = useMemo(
    () => list?.places.filter((p) => !todoOnly || !reviewed(p) || p.id === current) ?? [],
    [list, todoOnly, current],
  );

  const move = useCallback(
    (step: 1 | -1, from: string | null = current) => {
      const i = places.findIndex((p) => p.id === from);
      const next = places[Math.min(places.length - 1, Math.max(0, i + step))];
      if (next) setCurrent(next.id);
      setEditing(null);
    },
    [places, current],
  );

  const record = useCallback(
    async (placeId: string, fact: Fact) => {
      if (sending.current) return;
      sending.current = true;
      setPending(true);
      setError(null);
      try {
        const facts = await api<Partial<CurationPlace>>(`/admin/places/${placeId}/facts`, {
          method: "POST",
          body: JSON.stringify(fact),
        });
        setList((l) => l && { ...l, places: l.places.map((p) => (p.id === placeId ? { ...p, ...facts } : p)) });
        setEditing(null);
        // A verdict is the end of a place: on to the next.
        if (fact.kind !== "hours" && fact.kind !== "note") move(1, placeId);
      } catch (e) {
        setError(describeError(e));
      } finally {
        sending.current = false;
        setPending(false);
      }
    },
    [api, move],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.key === "Escape") return setEditing(null);
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select")) return;
      const place = places.find((p) => p.id === current);
      if (!place) return;
      const verdict = VERDICTS.find((v) => v.key === e.key);
      if (verdict) void record(place.id, { kind: verdict.kind });
      else if (e.key === "j") move(1);
      else if (e.key === "k") move(-1);
      else if (e.key === "h") setEditing("hours");
      else if (e.key === "n") setEditing("note");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [places, current, record, move]);

  useEffect(() => {
    document.getElementById(`place-${current}`)?.scrollIntoView?.({ block: "start", behavior: "auto" });
  }, [current]);

  if (missing) {
    return (
      <main className="curation">
        <h1>Not found</h1>
      </main>
    );
  }

  return (
    <main className="curation">
      <header className="curation-head">
        <h1>Places</h1>
        <label>
          neighbourhood{" "}
          <select
            value={area}
            onChange={(e) => {
              clear();
              setArea(e.target.value);
              e.target.blur();
            }}
          >
            {(list?.areas ?? [{ slug: area, name: area }]).map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={todoOnly} onChange={(e) => setTodoOnly(e.target.checked)} /> to do only
        </label>
        {list && (
          <p className="curation-count">
            {list.places.filter(reviewed).length} reviewed of {list.places.length}
            {list.total > list.places.length && ` (of ${list.total} places)`}
          </p>
        )}
        <p className="curation-keys">j/k next, back · g great · v verified · c closed · b bad fit · h hours · n note</p>
      </header>

      {error && (
        <p role="alert" className="curation-error">
          {error} {!list && <OSButton
              onClick={() => {
                clear();
                setTries((n) => n + 1);
              }}
            >
              try again
            </OSButton>}
        </p>
      )}
      {!list && !error && <p role="status">loading…</p>}
      {list && places.length === 0 && <p>nothing left to do here.</p>}

      <ol className="curation-list">
        {places.map((p) => (
          <Card
            key={p.id}
            place={p}
            active={p.id === current}
            editing={p.id === current ? editing : null}
            pending={pending}
            onSelect={() => {
              if (p.id !== current) {
                setCurrent(p.id);
                setEditing(null);
              }
            }}
            onEdit={setEditing}
            onRecord={(fact) => void record(p.id, fact)}
          />
        ))}
      </ol>
    </main>
  );
}

function Card({
  place: p,
  active,
  editing,
  pending,
  onSelect,
  onEdit,
  onRecord,
}: {
  place: CurationPlace;
  active: boolean;
  editing: Editing;
  pending: boolean;
  onSelect: () => void;
  onEdit: (e: Editing) => void;
  onRecord: (fact: Fact) => void;
}) {
  const website = webUrl(p.website);
  const instagram = webUrl(p.instagram);
  const map = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
  const handHours = p.hours.find((h) => h.source === "hand-verified")?.text ?? "";
  return (
    <li
      id={`place-${p.id}`}
      className="curation-card"
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      onFocus={onSelect}
    >
      <h2>{p.name}</h2>
      <p className="curation-meta">
        {p.category.replaceAll("_", " ")} · {p.address ?? "no street address on file"}
      </p>
      <p className="curation-links">
        <a href={map} target="_blank" rel="noreferrer">
          map
        </a>
        {website && (
          <a href={website} target="_blank" rel="noreferrer">
            website
          </a>
        )}
        {instagram && (
          <a href={instagram} target="_blank" rel="noreferrer">
            instagram
          </a>
        )}
      </p>
      {p.verdict && (
        <p>
          <strong>{VERDICT_LABEL[p.verdict.kind]}</strong> · {day(p.verdict.at)}
          {p.verdict.expired && " · older than 90 days, check again"}
        </p>
      )}
      {p.reliability && (
        <p>
          reliability {Math.round(p.reliability.score * 100)}%
          {p.reliability.suspended && <strong> · suspended until you verify it</strong>}
        </p>
      )}
      {p.hours.length === 0 ? (
        <p>hours: none on file</p>
      ) : (
        <ul aria-label="hours on file">
          {p.hours.slice(0, 4).map((h) => (
            <li key={`${h.source}-${h.service}-${h.at}`}>
              {h.service !== "regular" && `${h.service}: `}
              {h.text ?? "cleared"} · {h.source} {day(h.at)}
              {h.expired && " · expired"}
            </li>
          ))}
        </ul>
      )}
      {p.note && <p className="curation-note">note: {p.note.text}</p>}
      {p.reports.length > 0 && (
        <ul aria-label="recent reports">
          {p.reports.map((r, i) => (
            <li key={i}>
              {REPORT_LABEL[r.kind]} · {r.day}
            </li>
          ))}
        </ul>
      )}

      {active && (
        <>
          <div className="curation-actions">
            {VERDICTS.map((v) => (
              <OSButton key={v.kind} disabled={pending} onClick={() => onRecord({ kind: v.kind })}>
                {v.label}
              </OSButton>
            ))}
            <OSButton disabled={pending} onClick={() => onEdit("hours")}>
              edit hours
            </OSButton>
            <OSButton disabled={pending} onClick={() => onEdit("note")}>
              note
            </OSButton>
          </div>
          {editing === "hours" && (
            <TextFact
              label="hours (24-hour: Mo-Fr 09:00-17:00; Sa 10:00-14:00; PH off; empty clears)"
              initial={handHours}
              maxLength={1024}
              pending={pending}
              onSave={(hours) => onRecord({ kind: "hours", hours })}
              onCancel={() => onEdit(null)}
            />
          )}
          {editing === "note" && (
            <TextFact
              label="insider note (one line, empty clears)"
              initial={p.note?.text ?? ""}
              maxLength={MAX_NOTE_LENGTH}
              pending={pending}
              onSave={(note) => onRecord({ kind: "note", note })}
              onCancel={() => onEdit(null)}
            />
          )}
        </>
      )}
    </li>
  );
}

function TextFact({
  label,
  initial,
  maxLength,
  pending,
  onSave,
  onCancel,
}: {
  label: string;
  initial: string;
  maxLength: number;
  pending: boolean;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <form
      className="curation-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value);
      }}
    >
      <label>
        {label}
        <input
          ref={input}
          value={value}
          maxLength={maxLength}
          onChange={(e) => setValue(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>
      <OSButton type="submit" primary disabled={pending}>
        save
      </OSButton>
      <OSButton onClick={onCancel}>cancel</OSButton>
    </form>
  );
}
