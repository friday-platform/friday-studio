export interface FeatureFlags {
  ENABLE_WORKSPACE_PAGE_ACTIVITY: boolean;
  ENABLE_WORKSPACE_PAGE_LIBRARY: boolean;
  ENABLE_WORKSPACE_PAGE_CONVERSATIONS: boolean;
  ENABLE_WORKSPACE_PAGE_JOBS: boolean;
  ENABLE_WORKSPACE_NAV_ACTIVITY: boolean;
  ENABLE_WORKSPACE_NAV_RESOURCES: boolean;
  ENABLE_WORKSPACE_NAV_CONVERSATIONS: boolean;
  ENABLE_WORKSPACE_NAV_JOBS: boolean;
  ENABLE_LIBRARY_FILTERS: boolean;
  ENABLE_ACTIVITY_FILTERS: boolean;
  ENABLE_SKILLS_FILTERS: boolean;
  ENABLE_SKILL_ASSETS: boolean;
  ENABLE_SKILL_REFERENCES: boolean;
  ENABLE_GLOBAL_JOB_VIEWS: boolean;
}

const DEFAULT_FLAGS: FeatureFlags = {
  ENABLE_WORKSPACE_PAGE_ACTIVITY: false,
  ENABLE_WORKSPACE_PAGE_LIBRARY: false,
  ENABLE_WORKSPACE_PAGE_CONVERSATIONS: false,
  ENABLE_WORKSPACE_PAGE_JOBS: false,
  ENABLE_WORKSPACE_NAV_ACTIVITY: false,
  ENABLE_WORKSPACE_NAV_RESOURCES: false,
  ENABLE_WORKSPACE_NAV_CONVERSATIONS: false,
  ENABLE_WORKSPACE_NAV_JOBS: false,
  ENABLE_LIBRARY_FILTERS: false,
  ENABLE_ACTIVITY_FILTERS: false,
  ENABLE_SKILLS_FILTERS: false,
  ENABLE_SKILL_ASSETS: false,
  ENABLE_SKILL_REFERENCES: false,
  ENABLE_GLOBAL_JOB_VIEWS: false,
};

function isFeatureFlagKey(key: string): key is keyof FeatureFlags {
  return key in DEFAULT_FLAGS;
}

/** Parse `ff:<FLAG>=true|false` cookies from a raw Cookie header. */
export function parseCookieOverrides(cookieHeader: string): Partial<FeatureFlags> {
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const overrides: Partial<FeatureFlags> = {};
  for (const key of Object.keys(DEFAULT_FLAGS)) {
    if (!isFeatureFlagKey(key)) continue;
    const cookie = cookies.find((c) => c.startsWith(`ff:${key}=`));
    if (cookie) {
      overrides[key] = cookie.split("=")[1] === "true";
    }
  }
  return overrides;
}

/** Build a frozen FeatureFlags object from env overrides + cookie overrides. */
export function buildFeatureFlags(cookieOverrides: Partial<FeatureFlags> = {}): FeatureFlags {
  const envOverrides: Partial<FeatureFlags> = {};
  for (const flag of __FEATURE_FLAGS__) {
    if (isFeatureFlagKey(flag)) {
      envOverrides[flag] = true;
    }
  }
  return Object.freeze({ ...DEFAULT_FLAGS, ...envOverrides, ...cookieOverrides });
}
