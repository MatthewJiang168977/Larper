"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import {
  OSButton, OSDesktopIcon, OSMenuBar, OSQuestPanel, OSWindow, QuestFlag,
} from "@/components/larper-os/primitives";
import { fixtureLeads, quest } from "./quest-fixture-data";
import "./quest-fixture.css";

const DayMapFixture = dynamic(() => import("./day-map-fixture"), { ssr: false });

const states = ["offered", "accepted", "loading", "empty", "error"] as const;
type State = typeof states[number];

const statusCopy = {
  loading: { title: "finding your quest", body: "looking for places near you." },
  empty: { title: "nothing nearby yet", body: "there are no quests for this area right now." },
  error: { title: "couldn’t load your quest", body: "try again to look for places near you." },
};

export function QuestFixture() {
  const [state, setState] = useState<State>("offered");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);
  const [insets, setInsets] = useState({ bottomInset: 0, rightInset: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(false);
  const status = state === "offered" || state === "accepted" ? null : statusCopy[state];
  const lead = fixtureLeads.find(({ place }) => place.id === selectedId);

  useEffect(() => {
    if (moveFocus.current) {
      headingRef.current?.focus();
      moveFocus.current = false;
    }
  }, [state]);

  useEffect(() => {
    if (!showMap || !stageRef.current || !dockRef.current) return;
    const stage = stageRef.current;
    const dock = dockRef.current;
    function measure() {
      const wide = matchMedia("(min-width: 1024px)").matches;
      setInsets({
        bottomInset: wide ? 0 : dock.offsetHeight + parseFloat(getComputedStyle(stage).paddingBottom),
        rightInset: wide ? dock.offsetWidth + 10 : 0,
      });
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(dock);
    measure();
    return () => observer.disconnect();
  }, [showMap]);

  function chooseState(next: State) {
    setSelectedId(null);
    setState(next);
  }

  function runAction(next: State) {
    moveFocus.current = true;
    chooseState(next);
  }

  return (
    <div className="larper-lab-desktop">
      <OSMenuBar>
        <div className="larper-lab-review-controls">
          <OSButton aria-pressed={showMap} onClick={() => setShowMap(!showMap)}>day map</OSButton>
          <label className="larper-lab-selector">
            fixture state
            <select value={state} onChange={(event) => chooseState(event.target.value as State)}>
              {states.map((item) => <option key={item}>{item}</option>)}
            </select>
          </label>
        </div>
      </OSMenuBar>
      <div className="larper-lab-stage" ref={stageRef}>
        <div className="larper-lab-wallpaper" aria-hidden="true" />
        <div className="larper-lab-dock" ref={dockRef}>
          <OSWindow title="today’s quest" footer="design preview · sample places">
            {status ? (
              <>
                <OSQuestPanel role={state === "error" ? "alert" : "status"}>
                  <h1 ref={headingRef} tabIndex={-1} className="larper-lab-heading">{status.title}</h1>
                  <p>{status.body}</p>
                </OSQuestPanel>
                {state === "error" && <OSButton primary onClick={() => runAction("offered")}>try again</OSButton>}
              </>
            ) : (
              <>
                <OSQuestPanel>
                  <p className="larper-lab-kind"><QuestFlag /> {state === "accepted" ? "quest accepted" : "quest offered"}</p>
                  <h1 ref={headingRef} tabIndex={-1} className="larper-lab-heading">{quest.place.name}</h1>
                  <p>flip through the used bins for a record you’ve never heard.</p>
                </OSQuestPanel>
                {state === "offered" && <OSButton primary onClick={() => runAction("accepted")}>accept quest</OSButton>}
                <div className="larper-lab-leads" role="group" aria-label="Nearby leads">
                  {fixtureLeads.map(({ place }, index) => (
                    <OSDesktopIcon key={place.id} aria-label={`${index + 1}, ${place.name}`} aria-pressed={selectedId === place.id}
                      onClick={() => setSelectedId(selectedId === place.id ? null : place.id)}>
                      {index + 1}
                    </OSDesktopIcon>
                  ))}
                </div>
                <div aria-live="polite">
                  {lead && <OSQuestPanel><strong>{lead.place.name}</strong><p>{lead.note}</p></OSQuestPanel>}
                </div>
              </>
            )}
          </OSWindow>
        </div>
        {showMap && (
          <div className="larper-lab-day-map">
            <DayMapFixture showQuest={!status} selectedId={selectedId} onSelect={setSelectedId} {...insets} />
          </div>
        )}
      </div>
    </div>
  );
}
