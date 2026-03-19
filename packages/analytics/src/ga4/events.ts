export const GA4 = {
  // Auth UI - Login
  LOGIN_GOOGLE_CLICK: "login_google_click",
  LOGIN_MAGIC_LINK_SUBMIT: "login_magic_link_submit",
  LOGIN_MAGIC_LINK_SUCCESS: "login_magic_link_success",
  LOGIN_MAGIC_LINK_ERROR: "login_magic_link_error",
  LOGIN_SIGNUP_LINK_CLICK: "login_signup_link_click",

  // Auth UI - Signup
  SIGNUP_EMAIL_SUBMIT: "signup_email_submit",
  SIGNUP_EMAIL_SUCCESS: "signup_email_success",
  SIGNUP_EMAIL_ERROR: "signup_email_error",
  SIGNUP_GOOGLE_CLICK: "signup_google_click",
  SIGNUP_TERMS_TOGGLE: "signup_terms_toggle",
  SIGNUP_LOGIN_LINK_CLICK: "signup_login_link_click",
  SIGNUP_PRIVACY_LINK_CLICK: "signup_privacy_link_click",
  SIGNUP_TERMS_LINK_CLICK: "signup_terms_link_click",
  SIGNUP_RESEND_LINK_CLICK: "signup_resend_link_click",
  SIGNUP_SUPPORT_LINK_CLICK: "signup_support_link_click",

  // Auth UI - Confirm Email
  CONFIRM_EMAIL_VERIFY_CLICK: "confirm_email_verify_click",
  CONFIRM_EMAIL_VERIFY_SUCCESS: "confirm_email_verify_success",
  CONFIRM_EMAIL_VERIFY_ERROR: "confirm_email_verify_error",

  // Auth UI - Confirm Login
  CONFIRM_LOGIN_VERIFY_CLICK: "confirm_login_verify_click",
  CONFIRM_LOGIN_VERIFY_SUCCESS: "confirm_login_verify_success",
  CONFIRM_LOGIN_VERIFY_ERROR: "confirm_login_verify_error",

  // Auth UI - Signup Retry
  SIGNUP_RETRY_SUBMIT: "signup_retry_submit",
  SIGNUP_RETRY_SUCCESS: "signup_retry_success",
  SIGNUP_RETRY_ERROR: "signup_retry_error",

  // Auth UI - Profile Setup
  SETUP_PROFILE_SUBMIT: "setup_profile_submit",
  SETUP_PROFILE_SUCCESS: "setup_profile_success",
  SETUP_PROFILE_ERROR: "setup_profile_error",

  // Web Client - Navigation
  NAV_CLICK: "nav_click",
  SPACE_CLICK: "space_click",
  RECENT_CHAT_CLICK: "recent_chat_click",
  HELP_CLICK: "help_click",
  LOGOUT_CLICK: "logout_click",

  // Web Client - Sidebar Actions
  NEW_CHAT_CLICK: "new_chat_click",
  SHARE_CHAT_CLICK: "share_chat_click",
  DELETE_CHAT_CLICK: "delete_chat_click",
  DELETE_CHAT_CONFIRM: "delete_chat_confirm",

  // Web Client - Workspace Dialog
  WORKSPACE_DIALOG_OPEN: "workspace_dialog_open",
  WORKSPACE_FILE_SELECT: "workspace_file_select",
  WORKSPACE_FILE_DROP: "workspace_file_drop",
  WORKSPACE_CREATE: "workspace_create",

  // Web Client - Use Cases
  USE_CASE_SELECTED: "use_case_selected",

  // Web Client - Chat Session
  MESSAGE_SEND: "message_send",
  STREAM_START: "stream_start",
  STREAM_COMPLETE: "stream_complete",
  STREAM_ERROR: "stream_error",
  STREAM_STOP: "stream_stop",
  FILE_ATTACH: "file_attach",
  FILE_REMOVE: "file_remove",
  RECENT_CONVERSATIONS_EXPAND: "recent_conversations_expand",
  RECENT_CONVERSATION_SELECT: "recent_conversation_select",

  // Web Client - Settings
  CREDENTIAL_REMOVE: "credential_remove",
  CREDENTIAL_RENAME: "credential_rename",
  CREDENTIAL_SET_DEFAULT: "credential_set_default",

  // Web Client - Credential Linking
  CREDENTIAL_LINK_START: "credential_link_start",
  CREDENTIAL_LINK_SUCCESS: "credential_link_success",
  CREDENTIAL_LINK_ERROR: "credential_link_error",
  ENV_VAR_ADD: "env_var_add",
  ENV_VAR_REMOVE: "env_var_remove",
  ADVANCED_SETTINGS_EXPAND: "advanced_settings_expand",
  DAEMON_RESTART: "daemon_restart",

  // Web Client - Library
  ARTIFACT_VIEW: "artifact_view",
  ARTIFACT_DOWNLOAD: "artifact_download",

  // Web Client - Sessions
  SESSION_VIEW: "session_view",
  SESSION_ARTIFACT_CLICK: "session_artifact_click",
  SESSION_CHAT_LINK_CLICK: "session_chat_link_click",

  // Web Client - Spaces
  SPACE_VIEW: "space_view",
  SPACE_ARTIFACT_CLICK: "space_artifact_click",
  SPACE_SESSION_VIEW: "space_session_view",
  SPACE_SESSION_ARTIFACT_CLICK: "space_session_artifact_click",
  SPACE_SESSION_CHAT_LINK_CLICK: "space_session_chat_link_click",

  // Web Client - Workspace Management
  WORKSPACE_EXPORT: "workspace_export",
  WORKSPACE_DELETE_CLICK: "workspace_delete_click",
  WORKSPACE_DELETE_CONFIRM: "workspace_delete_confirm",
  WORKSPACE_FILE_PICKER_CLICK: "workspace_file_picker_click",

  // Web Client - Copy Actions
  COPY_SESSION_ID: "copy_session_id",
  COPY_WORKSPACE_ID: "copy_workspace_id",

  // Web Client - OAuth Fallback
  OAUTH_FALLBACK_CLICK: "oauth_fallback_click",
  APP_INSTALL_FALLBACK_CLICK: "app_install_fallback_click",

  // Web Client - Message Details
  REASONING_EXPAND: "reasoning_expand",
  PROGRESS_EXPAND: "progress_expand",
  ERROR_DETAILS_EXPAND: "error_details_expand",
  SHOW_DETAILS_EXPAND: "show_details_expand",

  // Web Client - Miscellaneous
  DAEMON_RECONNECT_CLICK: "daemon_reconnect_click",

  // Auth UI - Login
  LOGIN_GO_BACK: "login_go_back",
} as const;
