import { act, fireEvent, render, screen } from "@testing-library/react";
import { forwardRef, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Located } from "@/hooks/use-location";
import { ApiError, type Me, type Today } from "@/lib/api";
import { checkedIn, demoAccountLocation, QuestHome, SKIP_REASONS, SURVEY_MAX_MS, SURVEY_POLL_MS } from "./quest-home";

// --- the component's world, replaced -------------------------------------------

const userButton = vi.fn<(props: { appearance?: unknown }) => null>(() => null);
vi.mock("@clerk/nextjs", () => ({ UserButton: (p: { appearance?: unknown }) => userButton(p) }));
vi.mock("next/dynamic", () => ({ default: () => () => null })); // the WebGL map
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

let location: Located | null;
let retrying = false;
const retryLocation = vi.fn();
vi.mock("@/hooks/use-location", () => ({ useLocation: () => ({ loc: location, retry: retryLocation, retrying }) }));

// One stable api function (it's an effect dependency), answering from `routes`.
type Route = (path: string, init?: RequestInit) => Promise<unknown>;
const routes: Record<string, Route> = {};
const calls: string[] = [];
const bodies: { path: string; body: unknown }[] = [];
const api = vi.fn((path: string, init?: RequestInit) => {
  calls.push(path);
  if (init?.body) bodies.push({ path, body: JSON.parse(String(init.body)) });
  const route = Object.keys(routes).find((p) => path.startsWith(p));
  return route ? routes[route](path, init) : Promise.reject(new Error(`no route for ${path}`));
});
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  useApi: () => api,
}));

// The fresh check-in reading: each test decides what it returns (default: none).
const preciseFix = vi.fn<() => Promise<{ lat: number; lng: number; accuracyM: number } | null>>();
vi.mock("@/lib/precise-fix", () => ({ getPreciseFix: () => preciseFix() }));

// The peek height the stand-in sheet reports.
const SHEET_PEEK = 333;

// The sheet has its own tests (quest-sheet.test.tsx); here it only has to show what it
// got and act, and report what it covers the way the real one does.
vi.mock("./quest-sheet", () => ({
  QuestSheet: forwardRef<
    HTMLDivElement,
    {
      quest: Today["quest"];
      deck: Today["deck"];
      onAction: (a: string) => void;
      topLimit: number;
      onCoveredChange: (c: { bottom: number; right: number }) => void;
      note?: { tone: string; label: string; text: string; action?: { label: string; onClick: () => void; pending?: boolean } } | null;
      onDismissNote?: () => void;
    }
  >(function QuestSheet({ quest, deck, onAction, topLimit, onCoveredChange, note, onDismissNote }, ref) {
    useEffect(() => onCoveredChange({ bottom: SHEET_PEEK, right: 0 }), [onCoveredChange]);
    return (
      <section ref={ref} data-top-limit={topLimit}>
        {note && (
          <div role={note.tone === "rejected" ? "alert" : "status"} data-tone={note.tone}>
            <p>{note.label}</p>
            <p>{note.text}</p>
            {note.action && (
              <button onClick={note.action.onClick} disabled={note.action.pending}>
                {note.action.label}
              </button>
            )}
            <button aria-label="Dismiss" className="hit-target" onClick={onDismissNote}>
              ×
            </button>
          </div>
        )}
        <p>quest: {quest?.place.name ?? "none"}</p>
        <p>deck: {deck.length}</p>
        <button onClick={() => onAction("complete")}>I went</button>
        <button onClick={() => onAction("not-today")}>Set aside</button>
        <button onClick={() => onAction("skip")}>Skip</button>
      </section>
    );
  }),
}));

// --- fixtures -------------------------------------------------------------------

const HERE: Located = { lat: 40.7295, lng: -73.9965, source: "gps", accuracyM: 20 };
const demoSpot = (reason: Located["reason"]): Located => ({ lat: 40.7308, lng: -73.9973, source: "demo", reason });
const ME: Me = { id: "u1", onboarded: true, topTags: [] };
const place = (name: string) => ({
  id: name,
  name,
  lat: 40.73,
  lng: -73.99,
  category: "cafe",
  tags: [],
  distanceM: 100,
  website: null,
  instagram: null,
  phone: null,
});
const reasons = { liked: [], rarest: null, indie: false };
const withQuest: Today = {
  quest: { id: "q1", status: "offered", score: 1, reasons, createdAt: "", place: place("Cafe Uno") },
  deck: [{ score: 0.5, reasons, place: place("Bar Dos") }],
  cache: "miss",
  surveying: null,
};
const empty: Today = { quest: null, deck: [], cache: "miss", surveying: null };
const surveyingEmpty: Today = { ...empty, surveying: { pending: ["dr72h"], failed: [] } };

const ok = (v: unknown) => () => Promise.resolve(v);
const fail = (e: unknown) => () => Promise.reject(e);
const never = () => new Promise<never>(() => {});
const todayCalls = () => calls.filter((c) => c.startsWith("/quests/today")).length;

// Lets pending promises settle and React re-render, with fake or real timers.
const settle = () => act(async () => {});
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  location = HERE;
  retrying = false;
  retryLocation.mockClear();
  preciseFix.mockReset();
  preciseFix.mockResolvedValue(null);
  bodies.length = 0;
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  routes["/me"] = ok(ME);
});

describe("QuestHome: never stuck on 'Surveying…'", () => {
  it("says 'Finding you…' until there's a location", async () => {
    location = null;
    render(<QuestHome />);
    await settle();
    expect(screen.getByText("Finding you…")).toBeTruthy();
    expect(todayCalls()).toBe(0);
  });

  it("says 'Loading your quest…', not 'Surveying', while the request is in flight", async () => {
    routes["/quests/today"] = never;
    render(<QuestHome />);
    await settle();
    expect(screen.getByText("Loading your quest…")).toBeTruthy();
    expect(screen.queryByText(/Surveying/)).toBeNull();
  });

  it("shows an error with Retry when /me fails, and recovers", async () => {
    routes["/me"] = fail(new ApiError("boom", 503));
    routes["/quests/today"] = ok(withQuest);
    render(<QuestHome />);
    await settle();
    expect(screen.getByText("Couldn't load your journal")).toBeTruthy();
    expect(screen.getByText("Something went wrong on our end.")).toBeTruthy();
    expect(screen.queryByText(/Surveying|Loading your quest/)).toBeNull();

    routes["/me"] = ok(ME);
    fireEvent.click(screen.getByText("Retry"));
    await settle();
    expect(screen.getByText("quest: Cafe Uno")).toBeTruthy();
  });

  it("shows an error with Retry when /quests/today fails, and recovers", async () => {
    routes["/quests/today"] = fail(new ApiError("Internal server error", 500));
    render(<QuestHome />);
    await settle();
    expect(screen.getByText("Couldn't load your quest")).toBeTruthy();
    expect(screen.getByText("Something went wrong on our end.")).toBeTruthy();

    routes["/quests/today"] = ok(withQuest);
    fireEvent.click(screen.getByText("Retry"));
    await settle();
    expect(screen.getByText("quest: Cafe Uno")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the server is slow when the request times out", async () => {
    routes["/quests/today"] = fail(new ApiError("timed out", 0, "timeout"));
    render(<QuestHome />);
    await settle();
    expect(screen.getByText("The server is taking too long to answer.")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("shows the empty state with Try again when nothing is nearby", async () => {
    routes["/quests/today"] = ok(empty);
    render(<QuestHome />);
    await settle();
    expect(screen.getByText("Nothing quest-worthy within reach here. Try somewhere livelier.")).toBeTruthy();

    routes["/quests/today"] = ok(withQuest);
    fireEvent.click(screen.getByText("Try again"));
    await settle();
    expect(screen.getByText("quest: Cafe Uno")).toBeTruthy();
  });

  it("says the survey failed when the area's ingest is dead", async () => {
    routes["/quests/today"] = ok({ ...empty, surveying: { pending: [], failed: ["dr72h"] } });
    render(<QuestHome />);
    await settle();
    expect(screen.getByText("Couldn't survey this area just now. Try again in a bit.")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("polls while surveying and shows the quest once the area lands", async () => {
    vi.useFakeTimers();
    routes["/quests/today"] = ok(surveyingEmpty);
    render(<QuestHome />);
    await settle();
    expect(screen.getByText("Uncharted territory")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Surveying the area");

    await advance(SURVEY_POLL_MS);
    expect(todayCalls()).toBe(2);

    routes["/quests/today"] = ok(withQuest);
    await advance(SURVEY_POLL_MS);
    expect(screen.getByText("quest: Cafe Uno")).toBeTruthy();
    const after = todayCalls();
    await advance(SURVEY_POLL_MS * 3);
    expect(todayCalls()).toBe(after); // done surveying: no more polls
  });

  it("keeps polling through a failed poll, with the error shown", async () => {
    vi.useFakeTimers();
    routes["/quests/today"] = ok(surveyingEmpty);
    render(<QuestHome />);
    await settle();

    routes["/quests/today"] = fail(new ApiError("Bad gateway", 502));
    await advance(SURVEY_POLL_MS);
    expect(screen.getByRole("alert").textContent).toContain("Something went wrong on our end.");
    expect(screen.getByText("Uncharted territory")).toBeTruthy(); // the last good answer stays

    routes["/quests/today"] = ok(withQuest);
    await advance(SURVEY_POLL_MS);
    expect(screen.getByText("quest: Cafe Uno")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("after a 429, waits as long as the API asks before polling again", async () => {
    vi.useFakeTimers();
    routes["/quests/today"] = ok(surveyingEmpty);
    render(<QuestHome />);
    await settle();

    const limited = "Too many requests. Try again in 30 s.";
    routes["/quests/today"] = fail(new ApiError(limited, 429, "http", "rate_limited", 30));
    await advance(SURVEY_POLL_MS);
    expect(screen.getByRole("alert").textContent).toContain(limited);
    const after = todayCalls();

    routes["/quests/today"] = ok(withQuest);
    await advance(29_000);
    expect(todayCalls()).toBe(after); // not every 4 s
    await advance(1_000);
    expect(screen.getByText("quest: Cafe Uno")).toBeTruthy();
  });

  it("stops polling after SURVEY_MAX_MS and offers Check again", async () => {
    vi.useFakeTimers();
    routes["/quests/today"] = ok(surveyingEmpty); // the ingest never finishes
    render(<QuestHome />);
    await settle();

    // One poll at a time, so React re-arms the next one between ticks.
    for (let t = 0; t <= SURVEY_MAX_MS + SURVEY_POLL_MS; t += SURVEY_POLL_MS) await advance(SURVEY_POLL_MS);
    expect(screen.getByText("Taking longer than usual")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Still surveying");
    const stopped = todayCalls();
    await advance(SURVEY_POLL_MS * 5);
    expect(todayCalls()).toBe(stopped);

    routes["/quests/today"] = ok(withQuest);
    fireEvent.click(screen.getByText("Check again"));
    await settle();
    expect(screen.getByText("quest: Cafe Uno")).toBeTruthy();
  });

  it("shows an action's error with Dismiss and clears it on the next action", async () => {
    routes["/quests/today"] = ok(withQuest);
    routes["/quests/q1/complete"] = fail(new ApiError("You're 110 m away", 422));
    render(<QuestHome />);
    await settle();

    fireEvent.click(screen.getByText("I went"));
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("You're 110 m away");
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByText("I went"));
    await settle();
    expect(screen.getByRole("alert")).toBeTruthy();
    routes["/quests/q1/complete"] = ok({});
    fireEvent.click(screen.getByText("I went"));
    expect(screen.queryByRole("alert")).toBeNull(); // cleared as the next action starts
  });
});

describe("QuestHome: the map's stand-in area is labelled as such", () => {
  // The chip itself has its own tests (demo-notice.test.tsx); here, that QuestHome shows
  // it at the right times, with the right account's wording.
  beforeEach(() => sessionStorage.clear());

  it("says which area is showing and offers your location when the fallback kicks in", async () => {
    location = demoSpot("waiting");
    routes["/quests/today"] = ok(withQuest);
    render(<QuestHome />);
    await settle();
    const notice = screen.getByRole("region", { name: "Map area" });
    expect(notice.textContent).toContain("Washington Square");
    expect(notice.textContent).toContain("We couldn't find you yet.");
    expect(screen.getByText("quest: Cafe Uno")).toBeTruthy(); // the stand-in deck still works

    fireEvent.click(screen.getByText("Use my location"));
    expect(retryLocation).toHaveBeenCalledTimes(1);
  });

  it("never says 'demo' to a regular account", async () => {
    location = demoSpot("denied");
    routes["/quests/today"] = ok(withQuest);
    render(<QuestHome />);
    await settle();
    expect(screen.queryByRole("region", { name: "Demo area" })).toBeNull();
    expect(screen.getByRole("region", { name: "Map area" }).textContent).not.toMatch(/demo/i);
  });

  it("tells a user who denied location how to turn it back on", async () => {
    location = demoSpot("denied");
    routes["/quests/today"] = ok(withQuest);
    render(<QuestHome />);
    await settle();
    expect(screen.getByRole("region", { name: "Map area" }).textContent).toContain("Allow it in your browser's settings");
    expect(screen.getByText("Use my location")).toBeTruthy();
  });

  it("shows the retry as in progress, and none at all without GPS", async () => {
    location = demoSpot("waiting");
    retrying = true;
    routes["/quests/today"] = ok(withQuest);
    const { unmount } = render(<QuestHome />);
    await settle();
    expect((screen.getByText("Looking…") as HTMLButtonElement).disabled).toBe(true);
    unmount();

    location = demoSpot("no-gps");
    retrying = false;
    render(<QuestHome />);
    await settle();
    expect(screen.getByRole("region", { name: "Map area" })).toBeTruthy();
    expect(screen.queryByText("Use my location")).toBeNull();
  });

  it("shows no notice for a real fix", async () => {
    routes["/quests/today"] = ok(withQuest);
    render(<QuestHome />);
    await settle();
    expect(screen.queryByRole("region", { name: "Map area" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Demo area" })).toBeNull();
  });

  it("doesn't refetch the deck when only the location's note changes", async () => {
    location = demoSpot("waiting");
    routes["/quests/today"] = ok(withQuest);
    const { rerender } = render(<QuestHome />);
    await settle();
    const before = todayCalls();
    location = demoSpot("denied"); // same coordinates, new object
    rerender(<QuestHome />);
    await settle();
    expect(todayCalls()).toBe(before);
  });
});

describe("QuestHome: touch targets", () => {
  it("gives the avatar, the Journal link and Dismiss a 44 px hit area", async () => {
    routes["/quests/today"] = ok(withQuest);
    routes["/quests/q1/complete"] = fail(new ApiError("You're 110 m away", 422));
    render(<QuestHome />);
    await settle();
    expect(userButton).toHaveBeenLastCalledWith({ appearance: { elements: { userButtonTrigger: "hit-target" } } });
    expect(screen.getByRole("link", { name: "Journal" }).classList).toContain("hit-target");

    fireEvent.click(screen.getByText("I went"));
    await settle();
    expect(screen.getByLabelText("Dismiss").classList).toContain("hit-target");
  });
});

describe("QuestHome: checking in", () => {
  it("gets a precise fix first, saying so, and sends that reading", async () => {
    let answer!: (f: { lat: number; lng: number; accuracyM: number }) => void;
    preciseFix.mockReturnValue(new Promise((r) => (answer = r)));
    routes["/quests/today"] = ok(withQuest);
    routes["/quests/q1/complete"] = ok({ id: "q1", status: "completed" });
    render(<QuestHome />);
    await settle();

    fireEvent.click(screen.getByText("I went"));
    await settle();
    expect(screen.getByText("Getting a precise fix…")).toBeTruthy();
    expect(calls).not.toContain("/quests/q1/complete"); // waits for the reading

    answer({ lat: 40.7301, lng: -73.9951, accuracyM: 8 });
    await settle();
    expect(screen.queryByText("Getting a precise fix…")).toBeNull();
    expect(bodies).toEqual([{ path: "/quests/q1/complete", body: { lat: 40.7301, lng: -73.9951, accuracy: 8 } }]);
  });

  it("falls back to the map's position when no precise reading comes", async () => {
    routes["/quests/today"] = ok(withQuest);
    routes["/quests/q1/complete"] = ok({ id: "q1", status: "completed" });
    render(<QuestHome />);
    await settle();
    fireEvent.click(screen.getByText("I went"));
    await settle();
    expect(bodies[0].body).toEqual({ lat: HERE.lat, lng: HERE.lng, accuracy: HERE.accuracyM });
  });

  it("uses a ?at= override as is, without asking the GPS", async () => {
    location = { lat: 40.7, lng: -74, source: "override", note: "Location set by ?at=" };
    routes["/quests/today"] = ok(withQuest);
    routes["/quests/q1/complete"] = ok({ id: "q1", status: "completed" });
    render(<QuestHome />);
    await settle();
    fireEvent.click(screen.getByText("I went"));
    await settle();
    expect(preciseFix).not.toHaveBeenCalled();
    expect(bodies[0].body).toEqual({ lat: 40.7, lng: -74 });
  });

  it("explains a fix too rough to tell, and Try again takes a new reading", async () => {
    routes["/quests/today"] = ok(withQuest);
    const rough = "Your location is too rough to tell (±900 m). Turn on precise location or step outside, then try again.";
    routes["/quests/q1/complete"] = fail(new ApiError(rough, 422, "http", "too_rough"));
    render(<QuestHome />);
    await settle();

    fireEvent.click(screen.getByText("I went"));
    await settle();
    expect(screen.getByRole("alert").textContent).toContain(rough);

    preciseFix.mockResolvedValue({ lat: 40.7311, lng: -73.997, accuracyM: 6 });
    routes["/quests/q1/complete"] = ok({ id: "q1", status: "completed" });
    fireEvent.click(screen.getByText("Check again"));
    await settle();
    expect(preciseFix).toHaveBeenCalledTimes(2);
    expect(bodies.at(-1)?.body).toEqual({ lat: 40.7311, lng: -73.997, accuracy: 6 });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers Check again for 'too far' too, but not for other failures", async () => {
    routes["/quests/today"] = ok(withQuest);
    routes["/quests/q1/complete"] = fail(new ApiError("You're 300 m away. Check in when you're there.", 422, "http", "too_far"));
    const { unmount } = render(<QuestHome />);
    await settle();
    fireEvent.click(screen.getByText("I went"));
    await settle();
    expect(screen.getByText("Check again")).toBeTruthy();
    unmount();

    routes["/quests/q1/complete"] = fail(new ApiError("Internal server error", 500));
    render(<QuestHome />);
    await settle();
    fireEvent.click(screen.getByText("I went"));
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("Something went wrong on our end.");
    expect(screen.queryByText("Check again")).toBeNull();
  });

  it("says plainly when it checked in", async () => {
    routes["/quests/today"] = ok(withQuest);
    routes["/quests/q1/complete"] = ok({ id: "q1", status: "completed" });
    render(<QuestHome />);
    await settle();
    fireEvent.click(screen.getByText("I went"));
    await settle();
    const status = screen.getByRole("status", { name: "" });
    expect(status.textContent).toContain("Checked in");
    expect(status.textContent).toContain("Cafe Uno is in your journal.");
  });

  it("labels the demo account's check-in from afar as simulated", async () => {
    location = demoSpot("denied");
    routes["/quests/today"] = ok(withQuest);
    routes["/quests/q1/complete"] = ok({ id: "q1", status: "completed", simulated: true, distanceM: 306412 });
    render(<QuestHome />);
    await settle();
    fireEvent.click(screen.getByText("I went"));
    await settle();
    const note = document.querySelector('[data-tone="simulated"]')!;
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toContain("Simulated check-in · demo account");
    expect(note.textContent).toContain("You're 306 km from Cafe Uno, so the demo pretended you arrived.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("checkedIn", () => {
  it("words a real check-in, and a simulated one with or without the distance", () => {
    expect(checkedIn("Cafe Uno", { })).toEqual({ tone: "done", label: "Checked in", text: "Cafe Uno is in your journal." });
    expect(checkedIn("Cafe Uno", null).tone).toBe("done");
    expect(checkedIn("Cafe Uno", { simulated: true, distanceM: 2840 }).text).toMatch(/^You're 2\.8 km from Cafe Uno, so the demo pretended you arrived\./);
    expect(checkedIn("Cafe Uno", { simulated: true }).text).toMatch(/^You're not at the door, so/);
  });
});

describe("QuestHome: Not today", () => {
  const reasonsPrompt = () => screen.queryByRole("region", { name: "Why not today?" });
  const setAside = async () => {
    routes["/quests/today"] = ok(withQuest);
    routes["/quests/q1/not-today"] = ok({ id: "q1", status: "skipped" });
    routes["/quests/q1/reason"] = ok({});
    render(<QuestHome />);
    await settle();
    fireEvent.click(screen.getByText("Set aside"));
    await settle();
  };

  it("sets the quest aside with no reason, then offers the four reasons as optional", async () => {
    await setAside();
    expect(calls).toContain("/quests/q1/not-today");
    expect(calls.some((c) => c.endsWith("/reason"))).toBe(false); // neutral until the user says otherwise
    const prompt = reasonsPrompt()!;
    expect(prompt.textContent).toContain("optional");
    const chips = SKIP_REASONS.map(({ label }) => screen.getByRole("button", { name: label }));
    expect(chips.map((c) => c.textContent)).toEqual(["Not my thing", "Too far", "Not today", "Closed"]);
    for (const chip of chips) expect(chip.classList).toContain("min-h-11"); // 44 px tall
  });

  it.each(SKIP_REASONS)("records '$label' with one tap, and closes", async ({ reason, label }) => {
    await setAside();
    fireEvent.click(screen.getByRole("button", { name: label }));
    await settle();
    expect(bodies).toContainEqual({ path: "/quests/q1/reason", body: { reason } });
    expect(reasonsPrompt()).toBeNull();
  });

  it("closes without a reason when dismissed: nothing more is sent", async () => {
    await setAside();
    fireEvent.click(screen.getByRole("button", { name: "No reason" }));
    expect(reasonsPrompt()).toBeNull();
    expect(calls.some((c) => c.endsWith("/reason"))).toBe(false);
  });

  it("says so if the reason didn't save", async () => {
    await setAside();
    routes["/quests/q1/reason"] = fail(new ApiError("Network down", 0));
    fireEvent.click(screen.getByRole("button", { name: "Too far" }));
    await settle();
    expect(screen.getByRole("alert").textContent).toContain("Network down");
    expect(reasonsPrompt()).toBeNull();
  });

  it("asks nothing after a plain Skip", async () => {
    routes["/quests/today"] = ok(withQuest);
    routes["/quests/q1/skip"] = ok({});
    render(<QuestHome />);
    await settle();
    fireEvent.click(screen.getByText("Skip"));
    await settle();
    expect(calls).toContain("/quests/q1/skip");
    expect(reasonsPrompt()).toBeNull();
  });
});

describe("QuestHome: outside the demo region", () => {
  const outside: Today = { ...empty, surveying: { pending: [], failed: [], outside: ["gcpvj"] } };

  it("says the demo covers New York City and offers the demo area, instead of 'nothing here'", async () => {
    routes["/quests/today"] = ok(outside);
    const assign = vi.fn();
    const real = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...real, assign } });
    try {
      render(<QuestHome />);
      await settle();
      expect(screen.getByText("Outside the demo area")).toBeTruthy();
      expect(screen.queryByText("Uncharted")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Go to the demo area" }));
      expect(assign).toHaveBeenCalledWith(`${real.origin}/?at=40.7308,-73.9973`);
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: real });
    }
  });

  it("doesn't poll: there is nothing on its way", async () => {
    routes["/quests/today"] = ok(outside);
    render(<QuestHome />);
    await settle();
    const before = todayCalls();
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(todayCalls()).toBe(before);
  });

  it("shows the deck as usual when places are loaded there anyway", async () => {
    routes["/quests/today"] = ok({ ...withQuest, surveying: { pending: [], failed: [], outside: ["gcpvj"] } });
    render(<QuestHome />);
    await settle();
    expect(screen.getByText("quest: Cafe Uno")).toBeTruthy();
    expect(screen.queryByText("Outside the demo area")).toBeNull();
  });
});

describe("QuestHome: the demo account goes to Midtown", () => {
  const DEMO_ME: Me = { ...ME, demo: true };
  const outside: Today = { ...empty, surveying: { pending: [], failed: [], outside: ["dr5ru"] } };
  const MIDTOWN = "lat=40.7549&lng=-73.984";

  it("from outside the demo region: Midtown's deck, with a note and no 'outside' panel", async () => {
    routes["/me"] = ok(DEMO_ME);
    routes["/quests/today"] = (path) => Promise.resolve(path.includes(MIDTOWN) ? withQuest : outside);
    location = { lat: 41.88, lng: -87.63, source: "gps", accuracyM: 20 }; // Chicago
    render(<QuestHome />);
    await settle();
    await settle();
    expect(calls.filter((c) => c.startsWith("/quests/today"))).toEqual([
      "/quests/today?lat=41.88&lng=-87.63",
      `/quests/today?${MIDTOWN}`,
    ]);
    expect(screen.getByText("quest: Cafe Uno")).toBeTruthy();
    const notice = screen.getByRole("region", { name: "Demo area" });
    expect(notice.textContent).toContain("Demo · Midtown");
    expect(notice.textContent).toContain("You're exploring Midtown");
    expect(notice.textContent).toContain("outside New York City");
    expect(screen.queryByText("Use my location")).toBeNull();
    expect(screen.queryByText("Outside the demo area")).toBeNull();
  });

  it("with location denied: Midtown, not Washington Square, still offering to retry", async () => {
    routes["/me"] = ok(DEMO_ME);
    routes["/quests/today"] = ok(withQuest);
    location = demoSpot("denied");
    render(<QuestHome />);
    await settle();
    expect(calls).toContain(`/quests/today?${MIDTOWN}`);
    expect(screen.getByRole("region", { name: "Demo area" }).textContent).toContain("Demo · Midtown");
    expect(screen.getByText("Use my location")).toBeTruthy();
  });

  it("keeps a ?at= override as is, outside or not", () => {
    const at: Located = { lat: 41.88, lng: -87.63, source: "override" };
    expect(demoAccountLocation(at, true)).toBe(at);
    expect(demoAccountLocation(null, true)).toBeNull();
  });

  it("keeps a real fix inside the region", async () => {
    routes["/me"] = ok(DEMO_ME);
    routes["/quests/today"] = ok(withQuest);
    render(<QuestHome />);
    await settle();
    expect(calls).toContain("/quests/today?lat=40.7295&lng=-73.9965");
    expect(screen.queryByRole("region", { name: "Demo area" })).toBeNull();
  });

  it("is only for the demo account: anyone else outside still gets the 'outside' panel", async () => {
    routes["/quests/today"] = ok(outside);
    location = { lat: 41.88, lng: -87.63, source: "gps", accuracyM: 20 };
    render(<QuestHome />);
    await settle();
    expect(screen.getByText("Outside the demo area")).toBeTruthy();
    expect(calls.some((c) => c.includes(MIDTOWN))).toBe(false);
  });
});

describe("QuestHome: room for the quest sheet", () => {
  it("tells the sheet where the notices end", async () => {
    location = demoSpot("denied");
    routes["/quests/today"] = ok(withQuest);
    render(<QuestHome />);
    await settle();
    // jsdom has no layout, so the measured bottom is 0 here: it's passed, as a number.
    expect(screen.getByText("quest: Cafe Uno").closest("section")!.dataset.topLimit).toMatch(/^\d+$/);
  });

  it("keeps the notices above the sheet: they stop at its peek and scroll, never covering the place", async () => {
    location = demoSpot("denied");
    routes["/quests/today"] = ok(withQuest);
    render(<QuestHome />);
    await settle();
    const notices = screen.getByTestId("notices");
    // jsdom: the header measures 0 px, so the notices start 8 px down.
    expect(notices.style.top).toBe("8px");
    expect(notices.style.maxHeight).toBe(`calc(100% - ${8 + SHEET_PEEK + 8}px)`);
    expect(notices.className).toContain("overflow-y-auto");
  });

  it("gives the map's buttons a place in the top bar, which wraps them below the pill when both don't fit", async () => {
    routes["/quests/today"] = ok(withQuest);
    render(<QuestHome />);
    await settle();
    const slot = screen.getByTestId("map-controls");
    const header = slot.parentElement!;
    expect(header.tagName).toBe("HEADER");
    expect(header.className.split(" ")).toEqual(expect.arrayContaining(["flex-wrap", "justify-between"]));
    expect(slot.className.split(" ")).toContain("ml-auto"); // right-aligned on its own line too
    expect(header.contains(screen.getByRole("link", { name: "Journal" }))).toBe(true);
  });
});
