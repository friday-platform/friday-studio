//go:build !darwin

package main

// registerNSAppWillTerminate is a darwin-only mechanism. On Linux
// + Windows the systray-Quit + signal-handler paths cover the
// equivalent "external termination" cases (Job Object on Windows
// kills children when the parent dies; Linux signal handler runs
// performShutdown on SIGTERM).
func registerNSAppWillTerminate() {}
