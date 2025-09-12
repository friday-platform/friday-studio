/**
 * Safe date conversion utilities for memory deserialization
 * Handles type-safe conversion from serialized formats to Date objects
 */

import { logger } from "@atlas/logger";

/**
 * Safely converts a value to a Date object with fallback
 * @param value - The value to convert (string, number, or Date)
 * @param fallback - Fallback date if conversion fails (defaults to current time)
 * @returns Valid Date object
 */
export function safeToDate(value: unknown, fallback?: Date): Date {
  // If already a Date object, validate it
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? (fallback ?? new Date()) : value;
  }

  // Handle null/undefined
  if (value == null) {
    return fallback ?? new Date();
  }

  // Convert string or number to Date
  const date = new Date(value);

  // Check if the conversion resulted in a valid date
  if (Number.isNaN(date.getTime())) {
    logger.warn(`Invalid date value encountered during deserialization: ${value}`);
    return fallback ?? new Date();
  }

  return date;
}

/**
 * Type guard to check if a serialized memory object has required date fields
 */
export function hasValidTimestamps(
  obj: unknown,
): obj is { timestamp: unknown; lastAccessed: unknown } {
  return typeof obj === "object" && obj !== null && "timestamp" in obj && "lastAccessed" in obj;
}

/**
 * Safely restore a serialized memory object with proper date conversion
 * @param serializedMemory - The serialized memory object from storage (unknown type from JSON)
 * @returns Memory object with properly converted dates, cast to expected type
 */
export function restoreMemoryDates(
  serializedMemory: unknown,
): Record<string, unknown> & { timestamp: Date; lastAccessed: Date } {
  // Type guard to ensure we have an object with required properties
  if (!hasValidTimestamps(serializedMemory)) {
    throw new Error("Invalid serialized memory: missing timestamp fields");
  }

  const now = new Date();
  const memoryObj = serializedMemory;

  return {
    ...memoryObj,
    timestamp: safeToDate(memoryObj.timestamp, now),
    lastAccessed: safeToDate(memoryObj.lastAccessed, now),
  };
}
