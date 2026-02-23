export interface FeatureFlags {
  ENABLE_GLOBAL_SKILLS: boolean;
  ENABLE_WORKSPACE_SKILLS: boolean;
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
  ENABLE_GLOBAL_JOB_VIEWS: boolean;
}

const DEFAULT_FLAGS: FeatureFlags = {
  ENABLE_GLOBAL_SKILLS: false,
  ENABLE_WORKSPACE_SKILLS: false,
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
  ENABLE_GLOBAL_JOB_VIEWS: false,
};

function buildFeatureFlags(): FeatureFlags {
  const overrides = Object.fromEntries(__FEATURE_FLAGS__.map((f) => [f, true]));
  return Object.freeze({ ...DEFAULT_FLAGS, ...overrides }) as FeatureFlags;
}

/** Singleton — safe to import from load functions, components, anywhere. */
export const featureFlags: FeatureFlags = buildFeatureFlags();
