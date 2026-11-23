"use client";

import { UserButton, useUser } from "@clerk/nextjs";
import { larperOsClassName } from "@/app/larper-os";
import { avatarInitialsAppearance, larperOsAccountMenuAppearance, userProfileAppearance } from "./clerk-appearance";
import { DemoAccountMenu } from "./demo-account-menu";
import "./larper-os-account-menu.css";

const appearance = larperOsAccountMenuAppearance(larperOsClassName);

export function AccountMenu({ demo }: { demo: boolean }) {
  return demo ? <DemoAccountMenu /> : <ClerkAccountMenu />;
}

function ClerkAccountMenu() {
  const { user } = useUser();
  const initials = avatarInitialsAppearance(user);

  return (
    <UserButton
      appearance={initials ? { elements: { ...appearance.elements, ...initials.elements } } : appearance}
      userProfileProps={{ appearance: userProfileAppearance(user) }}
    />
  );
}
