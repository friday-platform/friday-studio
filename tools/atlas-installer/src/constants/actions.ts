/**
 * Action enums for type safety
 */

export enum DaemonAction {
  START = "start",
  STOP = "stop",
  RESTART = "restart",
}

export enum ServiceAction {
  INSTALL = "install",
  UNINSTALL = "uninstall",
  START = "start",
  STOP = "stop",
}
