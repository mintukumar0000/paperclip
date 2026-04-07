import posthog from "posthog-js";

const apiKey = (import.meta.env.VITE_POSTHOG_KEY ?? "").trim();
const host = (import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com").trim();

export const posthogConfigured = apiKey.length > 0;

if (posthogConfigured) {
  posthog.init(apiKey, {
    api_host: host,
    capture_pageview: false,
    capture_pageleave: true,
    person_profiles: "identified_only",
  });
}

export { posthog };
