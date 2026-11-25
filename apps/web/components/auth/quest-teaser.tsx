// Today's quest before sign-in. The API has no signed-out preview yet, so this says nothing
// about the quest (no category, no walk time): only that its name is hidden.
export function QuestTeaser({ page, layout }: { page: "sign in" | "sign up"; layout: "strip" | "card" }) {
  return (
    <div className={`larper-auth-teaser larper-auth-teaser-${layout}`}>
      {page === "sign up" ? (
        <p><span className="larper-auth-label">larper</span> <span>one quest a day, picked for you.</span></p>
      ) : (
        <p>
          <span className="larper-auth-label">today&apos;s quest:</span>{" "}
          <span className="larper-auth-redacted" role="img" aria-label="hidden until you sign in" />
          <span className="larper-auth-separator" aria-hidden="true"> · </span>
          <strong>sign in to see where</strong>
        </p>
      )}
    </div>
  );
}
