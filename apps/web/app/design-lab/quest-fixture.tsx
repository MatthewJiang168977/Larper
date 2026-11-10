"use client";

import { useEffect, useRef, useState } from "react";
import {
  OSButton, OSDesktopIcon, OSMenuBar, OSQuestPanel, OSWindow, QuestFlag,
} from "@/components/larper-os/primitives";
import "./quest-fixture.css";

const states = ["offered", "accepted", "loading", "empty", "error"] as const;
type State = typeof states[number];

const statusCopy = {
  loading: { title: "finding your quest", body: "looking for places near you." },
  empty: { title: "nothing nearby yet", body: "there are no quests for this area right now." },
  error: { title: "couldn’t load your quest", body: "try again to look for places near you." },
};

const leads = [
  { name: "The listening room", note: "a small room with a wall of records." },
  { name: "The tea counter", note: "a hojicha soft serve counter below street level." },
  { name: "The photo booth", note: "a vintage booth tucked behind the bar." },
];

export function QuestFixture() {
  const [state, setState] = useState<State>("offered");
  const [lead, setLead] = useState<number | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(false);
  const status = state === "offered" || state === "accepted" ? null : statusCopy[state];

  useEffect(() => {
    if (moveFocus.current) {
      headingRef.current?.focus();
      moveFocus.current = false;
    }
  }, [state]);

  function chooseState(next: State) {
    setLead(null);
    setState(next);
  }

  function runAction(next: State) {
    moveFocus.current = true;
    chooseState(next);
  }

  return (
    <div className="larper-lab-desktop">
      <OSMenuBar>
        <label className="larper-lab-selector">
          fixture state
          <select value={state} onChange={(event) => chooseState(event.target.value as State)}>
            {states.map((item) => <option key={item}>{item}</option>)}
          </select>
        </label>
      </OSMenuBar>
      <div className="larper-lab-stage">
        <div className="larper-lab-wallpaper" aria-hidden="true" />
        <div className="larper-lab-dock">
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
                  <h1 ref={headingRef} tabIndex={-1} className="larper-lab-heading">The Basement Record Shop</h1>
                  <p>flip through the used bins for a record you’ve never heard.</p>
                </OSQuestPanel>
                {state === "offered" && <OSButton primary onClick={() => runAction("accepted")}>accept quest</OSButton>}
                <div className="larper-lab-leads" role="group" aria-label="Nearby leads">
                  {leads.map((item, index) => (
                    <OSDesktopIcon key={item.name} aria-label={item.name} aria-pressed={lead === index}
                      onClick={() => setLead(lead === index ? null : index)}>
                      {index + 1}
                    </OSDesktopIcon>
                  ))}
                </div>
                <div aria-live="polite">
                  {lead !== null && <OSQuestPanel><strong>{leads[lead].name}</strong><p>{leads[lead].note}</p></OSQuestPanel>}
                </div>
              </>
            )}
          </OSWindow>
        </div>
      </div>
    </div>
  );
}
