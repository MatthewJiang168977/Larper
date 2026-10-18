import { act, fireEvent, render, screen } from "@testing-library/react";
import { forwardRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Located } from "@/hooks/use-location";
import { ApiError, type Me, type Today } from "@/lib/api";
import { QuestHome, SURVEY_MAX_MS, SURVEY_POLL_MS } from "./quest-home";

// --- the component's world, replaced -------------------------------------------

vi.mock("@clerk/nextjs", () => ({ UserButton: () => null }));
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
const api = vi.fn((path: string, init?: RequestInit) => {
  calls.push(path);
  const route = Object.keys(routes).find((p) => path.startsWith(p));
  return route ? routes[route](path, init) : Promise.reject(new Error(`no route for ${path}`));
});
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  useApi: () => api,
}));

// The sheet itself is tested by eye; here it only has to show what it got and act.
vi.mock("./quest-sheet", () => ({
  QuestSheet: forwardRef<HTMLDivElement, { quest: Today["quest"]; deck: Today["deck"]; onAction: (a: string) => void }>(
    function QuestSheet({ quest, deck, onAction }, ref) {
      return (
        <section ref={ref}>
          <p>quest: {quest?.place.name ?? "none"}</p>
          <p>deck: {deck.length}</p>
          <button onClick={() => onAction("complete")}>I went</button>
        </section>
      );
    },
  ),
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

describe("QuestHome: the demo area is labelled as such", () => {
  it("says it's a demo area and offers to retry when the location fallback kicks in", async () => {
    location = demoSpot("waiting");
    routes["/quests/today"] = ok(withQuest);
    render(<QuestHome />);
    await settle();
    const notice = screen.getByRole("region", { name: "Demo area" });
    expect(notice.textContent).toContain("Demo area: Washington Square.");
    expect(notice.textContent).toContain("We couldn't find you yet.");
    expect(screen.getByText("quest: Cafe Uno")).toBeTruthy(); // the demo deck still works

    fireEvent.click(screen.getByText("Try location again"));
    expect(retryLocation).toHaveBeenCalledTimes(1);
  });

  it("tells a user who denied location how to turn it back on", async () => {
    location = demoSpot("denied");
    routes["/quests/today"] = ok(withQuest);
    render(<QuestHome />);
    await settle();
    expect(screen.getByRole("region", { name: "Demo area" }).textContent).toContain("Allow it in your browser's settings");
    expect(screen.getByText("Try location again")).toBeTruthy();
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
    expect(screen.getByRole("region", { name: "Demo area" })).toBeTruthy();
    expect(screen.queryByText("Try location again")).toBeNull();
  });

  it("shows no demo notice for a real fix", async () => {
    routes["/quests/today"] = ok(withQuest);
    render(<QuestHome />);
    await settle();
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
