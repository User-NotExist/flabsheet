"use client";

import { useEffect } from "react";

import { notifySuccess } from "@/lib/notify";
import { takeSignedOut } from "@/lib/signed-out";

/** Confirms a sign-out on the landing page, where logout lands after a full reload. */
export function SignedOutToast() {
  useEffect(() => {
    if (takeSignedOut()) notifySuccess("Signed out.");
  }, []);
  return null;
}
