import { config as loadDotenv } from "dotenv";
import path from "node:path";
import {
  postToRedditPlaywright,
  posthogTrackEvent,
  triggerVercelDeploy,
  type IntegrationContext,
} from "../src/ai/tools/externalTools.js";

loadDotenv({ path: path.resolve(process.cwd(), ".env"), override: false });
loadDotenv({ path: path.resolve(process.cwd(), "..", ".env"), override: false });

type Company = { id: string; name: string; issuePrefix: string };
type Agent = { id: string; name: string };
type Issue = { id: string; identifier: string; title: string };
type ActivityEvent = { action: string; details?: Record<string, unknown>; createdAt: string };
type GovernanceMetricsResponse = {
  snapshot: {
    traffic: number;
    conversions: number;
    conversion_rate: number;
    sample_count: number;
  };
};
type LandingVariant = {
  id: string;
  headline: string;
  subheadline: string;
  ctaText: string;
};

type ScenarioConfig = {
  key: "resume_optimizer" | "cold_email_waitlist";
  goalText: string;
  companyNamePrefix: string;
  issueDescription: string;
  initialDeployName: string;
  improvedDeployName: string;
  title: string;
  bodyLine: string;
  inputPlaceholder: string;
  redditTitle: string;
  redditIntro: string;
  lowConversionIssueTitle: string;
  normalOptimizationIssueTitle: string;
};

const BASE_URL = (process.env.PAPERCLIP_API_BASE_URL ?? "http://localhost:3100/api").trim();
const SCENARIO = (process.env.DISTRIBUTION_SCENARIO ?? "resume_optimizer").trim().toLowerCase();
const DEFAULT_SUBREDDITS = ["SideProject", "Entrepreneur"];
const DEFAULT_POST_DELAY_MS = 30_000;
const DEFAULT_CONVERSION_ALERT_PERCENT = 2;

function getScenarioConfig(): ScenarioConfig {
  if (SCENARIO === "cold_email_waitlist" || SCENARIO === "waitlist") {
    return {
      key: "cold_email_waitlist",
      goalText: "Launch AI SaaS Waitlist + Validate Demand",
      companyNamePrefix: "Cold Email Waitlist E2E",
      issueDescription: "Real execution test for intelligence + orchestration + distribution + conversion loop",
      initialDeployName: "cold-email-waitlist-live",
      improvedDeployName: "cold-email-waitlist-improved",
      title: "AI Cold Email Generator",
      bodyLine: "Generate personalized cold emails for your ICP in under 30 seconds.",
      inputPlaceholder: "Work email",
      redditTitle: "I launched an AI cold email generator waitlist and need blunt feedback",
      redditIntro: "Built this to speed up outbound without writing robotic templates.",
      lowConversionIssueTitle: "Rewrite waitlist headline to improve conversion rate",
      normalOptimizationIssueTitle: "Improve waitlist conversion copy and CTA clarity",
    };
  }

  return {
    key: "resume_optimizer",
    goalText: "Create AI resume optimizer landing page and get traffic via reddit",
    companyNamePrefix: "Resume Optimizer E2E",
    issueDescription: "Real execution test for deploy + distribution + analytics + feedback loop",
    initialDeployName: "resume-optimizer-distribution-live",
    improvedDeployName: "resume-optimizer-distribution-improved",
    title: "AI Resume Optimizer",
    bodyLine: "Get role-matched resume edits and a concise action plan for your next application.",
    inputPlaceholder: "Work email",
    redditTitle: "I built a free AI tool that fixes resumes in seconds",
    redditIntro: "I built this after struggling with resumes and interview callbacks.",
    lowConversionIssueTitle: "Rewrite landing headline to improve conversion rate",
    normalOptimizationIssueTitle: "Improve resume landing conversion copy and CTA clarity",
  };
}

async function api<T>(pathName: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${pathName}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`API ${res.status} ${pathName}: ${JSON.stringify(payload)}`);
  }
  return payload as T;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function extractDeploymentUrl(result: unknown): string | null {
  const row = asObject(result);
  const deploymentUrl = typeof row.deploymentUrl === "string" ? row.deploymentUrl.trim() : "";
  if (deploymentUrl) return deploymentUrl;
  const url = typeof row.url === "string" ? row.url.trim() : "";
  if (!url) return null;
  return url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
}

function parseSubreddits(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return DEFAULT_SUBREDDITS;
  const items = raw
    .split(",")
    .map((item) => item.trim().replace(/^r\//i, ""))
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : DEFAULT_SUBREDDITS;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? "");
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n);
}

function parseNonNegativeNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? "");
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function isLoopbackUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return ["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function posthogSnippet(pageVersion: "initial" | "improved", variants: LandingVariant[]): string {
  const posthogKey = (process.env.VITE_POSTHOG_KEY ?? process.env.POSTHOG_API_KEY ?? "").trim();
  const posthogHost = (process.env.VITE_POSTHOG_HOST ?? process.env.POSTHOG_HOST ?? "https://us.i.posthog.com").trim();
  const publicBaseUrl = (
    process.env.PUBLIC_API_BASE
    ?? process.env.WAITLIST_PUBLIC_BASE_URL
    ?? process.env.PAPERCLIP_PUBLIC_BASE_URL
    ?? process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL
    ?? ""
  ).trim().replace(/\/$/, "");
  const derivedSignupEndpoint = publicBaseUrl ? `${publicBaseUrl}/api/waitlist/signup` : "";
  const explicitSignupEndpoint = (process.env.VITE_SIGNUP_ENDPOINT ?? process.env.SIGNUP_ENDPOINT ?? "").trim();
  const preferDerivedSignupEndpoint =
    explicitSignupEndpoint.length > 0
    && isLoopbackUrl(explicitSignupEndpoint)
    && derivedSignupEndpoint.length > 0
    && !isLoopbackUrl(derivedSignupEndpoint);
  const signupEndpoint = (preferDerivedSignupEndpoint ? derivedSignupEndpoint : (explicitSignupEndpoint || derivedSignupEndpoint)).trim();
  const paymentLink = (process.env.WAITLIST_OFFER_PAYMENT_LINK ?? process.env.DODO_PAYMENTS_CHECKOUT_URL ?? "").trim();
  const keyLiteral = JSON.stringify(posthogKey);
  const hostLiteral = JSON.stringify(posthogHost);
  const signupEndpointLiteral = JSON.stringify(signupEndpoint);
  const paymentLinkLiteral = JSON.stringify(paymentLink);
  const versionLiteral = JSON.stringify(pageVersion);
  const variantsLiteral = JSON.stringify(variants);

  return `<script>(function(){
var POSTHOG_KEY=${keyLiteral};
var POSTHOG_HOST=${hostLiteral};
var SIGNUP_ENDPOINT=${signupEndpointLiteral};
var PAYMENT_LINK=${paymentLinkLiteral};
var LANDING_VARIANTS=${variantsLiteral};
if(!POSTHOG_KEY){return;}
!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split('.');2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement('script')).type='text/javascript',p.async=!0,p.src='https://us.i.posthog.com/static/array.js',(r=t.getElementsByTagName('script')[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a='posthog',u.people=u.people||[],u.toString=function(t){var e='posthog';return'posthog'!==a&&(e+='.'+a),t||(e+=' (stub)'),e},u.people.toString=function(){return u.toString(1)+'.people (stub)'},o='capture identify alias people.set people.set_once'.split(' '),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
posthog.init(POSTHOG_KEY,{api_host:POSTHOG_HOST});
var signupEndpointIsLoopback=/^https?:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(SIGNUP_ENDPOINT);
if(signupEndpointIsLoopback&&!/^(localhost|127\.|0\.0\.0\.0)$/i.test(window.location.hostname)){
  // Deployed pages cannot post to localhost. Treat as not configured.
  SIGNUP_ENDPOINT='';
}
function getDistinctId(){
  try{
    var key='resume_optimizer_distinct_id';
    var existing=localStorage.getItem(key);
    if(existing){return existing;}
    var created='visitor_'+Date.now()+'_'+Math.random().toString(36).slice(2,10);
    localStorage.setItem(key,created);
    return created;
  }catch(_){
    return 'visitor_'+Date.now()+'_'+Math.random().toString(36).slice(2,10);
  }
}
var distinctId=getDistinctId();
posthog.identify(distinctId);
function stableVariantIndex(seed,size){
  var hash=0;
  for(var i=0;i<seed.length;i++){hash=((hash<<5)-hash)+seed.charCodeAt(i);hash|=0;}
  var positive=Math.abs(hash);
  return size>0?positive%size:0;
}
function pickVariant(){
  if(!Array.isArray(LANDING_VARIANTS)||LANDING_VARIANTS.length===0){return null;}
  try{
    var key='resume_optimizer_ab_variant_${pageVersion}';
    var stored=localStorage.getItem(key);
    var idx=stored?Number(stored):-1;
    if(!Number.isInteger(idx)||idx<0||idx>=LANDING_VARIANTS.length){
      idx=stableVariantIndex(distinctId,LANDING_VARIANTS.length);
      localStorage.setItem(key,String(idx));
    }
    return LANDING_VARIANTS[idx];
  }catch(_){
    return LANDING_VARIANTS[stableVariantIndex(distinctId,LANDING_VARIANTS.length)];
  }
}
var chosenVariant=pickVariant();
if(chosenVariant){
  var headlineEl=document.querySelector('[data-copy="headline"]');
  var subheadlineEl=document.querySelector('[data-copy="subheadline"]');
  var ctaEl=document.querySelector('[data-cta="primary"]');
  if(headlineEl){headlineEl.textContent=chosenVariant.headline;}
  if(subheadlineEl){subheadlineEl.textContent=chosenVariant.subheadline;}
  if(ctaEl){ctaEl.textContent=chosenVariant.ctaText;}
}
var variantId=chosenVariant&&chosenVariant.id?chosenVariant.id:'unknown';
posthog.capture('landing_view',{source:'reddit',page_version:${versionLiteral},variant_id:variantId});
var ctaButton=document.querySelector('[data-cta="primary"]');
if(ctaButton){
  ctaButton.addEventListener('click',function(){});
}
var form=document.querySelector('[data-form="signup"]');
var paymentCta=document.querySelector('[data-cta="payment"]');
if(paymentCta){
  paymentCta.addEventListener('click',function(){
    posthog.capture('payment_started',{source:'reddit',page_version:${versionLiteral},variant_id:variantId,entry:'landing_cta'});
  });
}
if(form){
  form.addEventListener('submit',async function(event){
    if(event&&typeof event.preventDefault==='function'){event.preventDefault();}
    var nameInput=document.querySelector('input[name="name"]');
    var emailInput=document.querySelector('input[name="email"]');
    var message=document.querySelector('[data-signup="message"]');
    var offerBox=document.querySelector('[data-offer="box"]');
    var offerLink=document.querySelector('[data-offer="link"]');
    var submitButton=document.querySelector('[data-cta="primary"]');
    var nameValue=nameInput&&nameInput.value?String(nameInput.value).trim():'';
    var value=emailInput&&emailInput.value?String(emailInput.value).trim():'';
    var isEmail=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    var domain=value.indexOf('@')>-1?value.split('@')[1]:'';
    if(!isEmail){
      posthog.capture('signup_error',{source:'reddit',page_version:${versionLiteral},variant_id:variantId,error:'invalid_email'});
      if(message){message.textContent='Enter a valid email to continue.';}
      return;
    }
    if(!SIGNUP_ENDPOINT){
      posthog.capture('signup_error',{source:'reddit',page_version:${versionLiteral},variant_id:variantId,error:'signup_endpoint_not_configured',email_domain:domain});
      if(message){message.textContent='Signup backend not configured for this deployment.';}
      return;
    }
    posthog.capture('cta_clicked',{source:'reddit',page_version:${versionLiteral},variant_id:variantId,cta_text:submitButton&&submitButton.textContent?submitButton.textContent:'',email_domain:domain});
    posthog.capture('signup_submitted',{source:'reddit',page_version:${versionLiteral},variant_id:variantId,email_domain:domain});
    if(submitButton&&'disabled' in submitButton){submitButton.disabled=true;}
    if(message){message.textContent='Submitting...';}
    try{
      var response=await fetch(SIGNUP_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:nameValue,email:value,source:'reddit',variantId:variantId,pageVersion:${versionLiteral}})});
      if(!response.ok){throw new Error('signup_api_'+response.status);}
      try{localStorage.setItem('resume_optimizer_last_signup_email',value);}catch(_){/* ignore */}
      posthog.capture('user_signed_up',{source:'reddit',page_version:${versionLiteral},variant_id:variantId,email_domain:domain,mode:'api'});
      if(message){message.textContent='Success. You are in. Check your inbox in a minute.';}
      if(offerLink&&PAYMENT_LINK){offerLink.setAttribute('href',PAYMENT_LINK);}
      if(offerBox){offerBox.style.display='block';}
    }catch(err){
      var errorMessage=err&&err.message?String(err.message):'unknown_error';
      posthog.capture('signup_error',{source:'reddit',page_version:${versionLiteral},variant_id:variantId,error:errorMessage,email_domain:domain});
      if(submitButton&&'disabled' in submitButton){submitButton.disabled=false;}
      if(message){message.textContent='Signup failed. Please retry in a few seconds.';}
    }
  });
}
})();</script>`;
}

function buildVariants(pageVersion: "initial" | "improved", scenario: ScenarioConfig): LandingVariant[] {
  if (scenario.key === "cold_email_waitlist") {
    if (pageVersion === "initial") {
      return [
        {
          id: "v1",
          headline: "Write high-converting cold emails in 30 seconds",
          subheadline: "Paste your offer and audience. Get a personalized sequence instantly.",
          ctaText: "Join Waitlist ->",
        },
        {
          id: "v2",
          headline: "Stop writing cold emails from scratch",
          subheadline: "AI drafts outreach that sounds human and matches your ICP.",
          ctaText: "Get Early Access ->",
        },
        {
          id: "v3",
          headline: "Turn product notes into outbound campaigns",
          subheadline: "Generate first-touch emails and follow-ups in one click.",
          ctaText: "Reserve My Spot ->",
        },
      ];
    }

    return [
      {
        id: "v1",
        headline: "Generate personalized outbound emails that book more calls",
        subheadline: "AI drafts sequences tuned to your ICP, offer, and proof points.",
        ctaText: "Join Beta Waitlist ->",
      },
      {
        id: "v2",
        headline: "Book meetings faster with role-aware cold email copy",
        subheadline: "Create campaign-ready drafts in under a minute.",
        ctaText: "Get Priority Access ->",
      },
      {
        id: "v3",
        headline: "Outbound copy that sounds like you, not a bot",
        subheadline: "Cleaner personalization, stronger hooks, fewer rewrites.",
        ctaText: "Start On The Waitlist ->",
      },
    ];
  }

  if (pageVersion === "initial") {
    return [
      {
        id: "v1",
        headline: "Get 5 AI tools that save founders 10+ hours every week",
        subheadline: "Join 1,000+ builders using AI to grow faster",
        ctaText: "Get Free Tools ->",
      },
      {
        id: "v2",
        headline: "Steal the exact AI toolkit founders use to move 2x faster",
        subheadline: "Practical tools for research, copy, and execution in one place",
        ctaText: "Send Me The Toolkit ->",
      },
      {
        id: "v3",
        headline: "Work one day ahead with founder-ready AI tools",
        subheadline: "Free stack used by indie builders to ship more every week",
        ctaText: "Unlock Free AI Stack ->",
      },
    ];
  }

  return [
    {
      id: "v1",
      headline: "Rewrite your resume for the role you actually want",
      subheadline: "ATS-focused bullet upgrades in under a minute",
      ctaText: "Get My Rewrite ->",
    },
    {
      id: "v2",
      headline: "Turn a weak resume into interview-worthy proof in 60 seconds",
      subheadline: "Role-targeted edits that hiring teams understand fast",
      ctaText: "Fix My Resume Free ->",
    },
    {
      id: "v3",
      headline: "Stop guessing resume copy. Use AI edits that read like wins",
      subheadline: "Cleaner bullets, better metrics, sharper role alignment",
      ctaText: "Show Me Better Bullets ->",
    },
  ];
}

function buildLandingHtml(params: {
  inputPlaceholder: string;
  version: "initial" | "improved";
  scenario: ScenarioConfig;
}): string {
  const variants = buildVariants(params.version, params.scenario);
  const firstVariant = variants[0];
  const paymentLink = (process.env.WAITLIST_OFFER_PAYMENT_LINK ?? process.env.DODO_PAYMENTS_CHECKOUT_URL ?? "").trim();
  return "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>"
    + params.scenario.title
    + "</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6fb;color:#101828;margin:0;padding:0}main{max-width:640px;margin:6vh auto;padding:28px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 12px 30px rgba(16,24,40,.08)}h1{font-size:34px;line-height:1.1;margin:0 0 12px}p{margin:10px 0 0}form{margin-top:18px;display:flex;gap:10px;flex-wrap:wrap}input[name='name'],input[name='email']{flex:1;min-width:230px;padding:13px 12px;border:1px solid #cbd5e1;border-radius:10px;font-size:15px}button[data-cta='primary'],a[data-cta='payment']{padding:13px 16px;border:0;border-radius:10px;background:#0f172a;color:#fff;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}.trust{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.pill{font-size:12px;color:#0f172a;background:#e2e8f0;padding:4px 8px;border-radius:999px}[data-signup='message']{margin-top:10px;color:#0f172a;min-height:1.4em;font-size:14px}[data-offer='box']{display:none;margin-top:16px;padding:14px;border:1px solid #d1fae5;background:#ecfdf5;border-radius:10px}</style></head><body><main>"
    + "<h1 data-copy='headline'>"
    + firstVariant.headline
    + "</h1><p data-copy='subheadline'>"
    + firstVariant.subheadline
    + "</p><p>"
    + params.scenario.bodyLine
    + "</p><div class='trust'><span class='pill'>Takes 10 seconds</span><span class='pill'>No credit card</span></div><form data-form='signup'><input type='text' autocomplete='name' name='name' placeholder='Your name (optional)'><input type='email' autocomplete='email' name='email' placeholder='"
    + params.inputPlaceholder
    + "' required><button data-cta='primary' type='submit'>"
    + firstVariant.ctaText
    + "</button></form><p data-signup='message' style='min-height:1.4em;'></p><div data-offer='box'><p><strong>Want instant value?</strong> Get premium cold email templates for $5.</p><a data-offer='link' data-cta='payment' href='"
    + (paymentLink || "#")
    + "' target='_blank' rel='noopener noreferrer'>Get Premium Templates - $5</a></div></main>"
    + posthogSnippet(params.version, variants)
    + "</body></html>";
}

async function main(): Promise<void> {
  const scenario = getScenarioConfig();
  const company = await api<Company>("/companies", {
    method: "POST",
    body: JSON.stringify({
      name: `${scenario.companyNamePrefix} ${new Date().toISOString().slice(11, 19)}`,
    }),
  });

  const agent = await api<Agent>(`/companies/${company.id}/agents`, {
    method: "POST",
    body: JSON.stringify({
      name: "Distribution CEO",
      role: "ceo",
      adapterType: "process",
      adapterConfig: {},
    }),
  });

  const issue = await api<Issue>(`/companies/${company.id}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: scenario.goalText,
      description: scenario.issueDescription,
      priority: "high",
      status: "todo",
      assigneeAgentId: agent.id,
    }),
  });

  const integrationCtx: IntegrationContext = { integrationEnv: {} };

  const initialLandingHtml = buildLandingHtml({
    inputPlaceholder: scenario.inputPlaceholder,
    version: "initial",
    scenario,
  });
  const improvedLandingHtml = buildLandingHtml({
    inputPlaceholder: scenario.inputPlaceholder,
    version: "improved",
    scenario,
  });

  const deploy1 = await triggerVercelDeploy(integrationCtx, {
    mode: "auto",
    name: scenario.initialDeployName,
    files: [{ file: "index.html", data: initialLandingHtml }],
  });
  const deploy1Url = extractDeploymentUrl(deploy1);
  if (!deploy1Url) {
    throw new Error("Deployment did not return a URL");
  }

  const targetSubreddits = parseSubreddits(process.env.REDDIT_TARGET_SUBREDDITS);
  const postDelayMs = parsePositiveInt(process.env.REDDIT_POST_DELAY_MS, DEFAULT_POST_DELAY_MS);
  const redditAttempts: Array<{ subreddit: string; status: "completed" | "failed"; output?: unknown; error?: string }> = [];
  const redditPostUrls: string[] = [];
  let redditError: string | null = null;

  for (let index = 0; index < targetSubreddits.length; index += 1) {
    const subreddit = targetSubreddits[index];
    try {
      const redditPost = await postToRedditPlaywright(integrationCtx, {
        subreddit,
        kind: "link",
        title: scenario.redditTitle,
        url: deploy1Url,
        text:
          scenario.redditIntro
          + "\n\nWould love blunt feedback:\n-> "
          + deploy1Url
          + "\n\nWhat would make you sign up?",
        maxAttempts: parsePositiveInt(process.env.REDDIT_MAX_ATTEMPTS, 3),
        retryDelayMs: parsePositiveInt(process.env.REDDIT_RETRY_DELAY_MS, 8_000),
        preSubmitDelayMs: parsePositiveInt(process.env.REDDIT_PRE_SUBMIT_DELAY_MS, 3_000),
        requireStorageState: true,
        allowPasswordLogin: false,
        headless: false,
        uniqueUserDataDir: true,
        userDataDir:
          process.env.REDDIT_USER_DATA_DIR
          ?? process.env.PLAYWRIGHT_USER_DATA_DIR
          ?? "data/playwright/reddit-profile",
      });

      const redditRow = asObject(redditPost);
      const postUrl = typeof redditRow.postUrl === "string" ? redditRow.postUrl : "";
      if (postUrl) redditPostUrls.push(postUrl);

      redditAttempts.push({ subreddit, status: "completed", output: redditPost });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      redditAttempts.push({ subreddit, status: "failed", error: message });
    }

    const isLast = index === targetSubreddits.length - 1;
    if (!isLast && postDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, postDelayMs));
    }
  }

  if (redditAttempts.every((attempt) => attempt.status === "failed")) {
    redditError = redditAttempts.map((attempt) => `${attempt.subreddit}: ${attempt.error ?? "failed"}`).join(" | ");
  }

  const posthogKey = (process.env.VITE_POSTHOG_KEY ?? process.env.POSTHOG_API_KEY ?? "").trim();
  const posthogHost = (process.env.VITE_POSTHOG_HOST ?? process.env.POSTHOG_HOST ?? "https://us.i.posthog.com").trim();
  const trackingPublicBase = (
    process.env.PUBLIC_API_BASE
    ?? process.env.WAITLIST_PUBLIC_BASE_URL
    ?? process.env.PAPERCLIP_PUBLIC_BASE_URL
    ?? process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL
    ?? ""
  ).trim().replace(/\/$/, "");
  const derivedPublicSignupEndpoint = trackingPublicBase ? `${trackingPublicBase}/api/waitlist/signup` : "";
  const signupEndpoint = (
    process.env.VITE_SIGNUP_ENDPOINT
    ?? process.env.SIGNUP_ENDPOINT
    ?? derivedPublicSignupEndpoint
  ).trim();
  const effectiveSignupEndpoint =
    signupEndpoint.length > 0
    && isLoopbackUrl(signupEndpoint)
    && derivedPublicSignupEndpoint.length > 0
    && !isLoopbackUrl(derivedPublicSignupEndpoint)
      ? derivedPublicSignupEndpoint
      : signupEndpoint;
  const signupEndpointLooksPublic = effectiveSignupEndpoint.length > 0 && !isLoopbackUrl(effectiveSignupEndpoint);
  const trackingSetup = {
    mode: "browser_real_user",
    posthogConfigured: posthogKey.length > 0,
    posthogHost,
    signupEndpoint: effectiveSignupEndpoint,
    signupEndpointLooksPublic,
    events: ["landing_view", "cta_clicked", "signup_submitted", "user_signed_up", "signup_error"],
    phase1: {
      signupFlow: "no_reload_form_submit",
      hasEmailInput: true,
      hasPrimaryCta: true,
    },
    phase2: {
      abTestingEnabled: true,
      variantCount: 3,
    },
  };

  let posthogRunnerHeartbeat: unknown = null;
  let posthogRunnerHeartbeatError: string | null = null;
  try {
    posthogRunnerHeartbeat = await posthogTrackEvent(integrationCtx, {
      event: "distribution_runner_completed",
      distinctId: "real-distribution-runner",
      properties: { source: "reddit", deploymentUrl: deploy1Url, redditPosts: redditPostUrls.length },
    });
  } catch (err) {
    posthogRunnerHeartbeatError = err instanceof Error ? err.message : String(err);
  }

  const metricsWindowMinutes = parsePositiveInt(process.env.DECISION_METRICS_WINDOW_MINUTES, 180);
  const conversionThresholdPercent = parseNonNegativeNumber(
    process.env.AI_CONVERSION_THRESHOLD_PERCENT,
    DEFAULT_CONVERSION_ALERT_PERCENT,
  );
  const governanceMetrics = await api<GovernanceMetricsResponse>(
    `/companies/${company.id}/governance/system-metrics?windowMinutes=${metricsWindowMinutes}`,
  );
  const decisionCycleResult = await api<unknown>(`/companies/${company.id}/governance/decision-cycle`, {
    method: "POST",
    body: JSON.stringify({ windowMinutes: metricsWindowMinutes }),
  });
  const observedConversionPercent = governanceMetrics.snapshot.conversion_rate;
  const lowConversionDetected = observedConversionPercent < conversionThresholdPercent;

  const optimizationIssue = await api<Issue>(`/companies/${company.id}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: lowConversionDetected
        ? scenario.lowConversionIssueTitle
        : scenario.normalOptimizationIssueTitle,
      description: lowConversionDetected
        ? `Created by Phase 3 decision rule: conversion ${observedConversionPercent.toFixed(2)}% < ${conversionThresholdPercent.toFixed(2)}%.`
        : "Created after first launch for optimization loop.",
      priority: "high",
      status: "todo",
      assigneeAgentId: agent.id,
    }),
  });

  const deploy2 = await triggerVercelDeploy(integrationCtx, {
    mode: "auto",
    name: scenario.improvedDeployName,
    files: [{ file: "index.html", data: improvedLandingHtml }],
  });
  const deploy2Url = extractDeploymentUrl(deploy2);

  const activity = await api<ActivityEvent[]>(`/companies/${company.id}/activity`);
  const activitySignals = activity
    .filter((e) => e.action.includes("ai") || e.action.includes("issue") || e.action.includes("decision"))
    .slice(0, 50);

  const summary = {
    goal: scenario.goalText,
    company,
    agent,
    issue,
    execution: {
      status: redditError || posthogRunnerHeartbeatError ? "partial" : "completed",
      steps: [
        { name: "Deploy landing page", status: "completed", output: deploy1 },
        {
          name: "Post on Reddit",
          status: redditError ? "failed" : "completed",
          output: { targetSubreddits, attempts: redditAttempts },
          error: redditError,
        },
        { name: "Configure browser-side tracking", status: trackingSetup.posthogConfigured ? "completed" : "failed", output: trackingSetup, error: trackingSetup.posthogConfigured ? null : "Missing PostHog key" },
        { name: "Track runner heartbeat", status: posthogRunnerHeartbeatError ? "failed" : "completed", output: posthogRunnerHeartbeat, error: posthogRunnerHeartbeatError },
        {
          name: "Run conversion decision cycle",
          status: "completed",
          output: {
            thresholdPercent: conversionThresholdPercent,
            observedConversionPercent,
            lowConversionDetected,
            metricsWindowMinutes,
            metricsSnapshot: governanceMetrics.snapshot,
            decisionCycleResult,
          },
          error: null,
        },
        { name: "Create optimization issue", status: "completed", output: optimizationIssue },
        { name: "Redeploy improved landing", status: "completed", output: deploy2 },
      ],
    },
    urls: {
      vercelInitial: deploy1Url,
      vercelImproved: deploy2Url,
      redditPosts: redditPostUrls,
    },
    activitySignals,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
