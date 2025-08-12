import { z } from "zod/v4";
import { TodoItemSchema as BaseTodoItemSchema } from "@atlas/config";

// ============================================================================
// Parameter Schemas
// ============================================================================

export const streamIdParamSchema = z.object({
  streamId: z.string().min(1).meta({ description: "Stream ID for todo operations" }),
}).meta({ description: "Stream ID parameter" });

// ============================================================================
// Data Schemas
// ============================================================================

// Re-export the shared TodoItemSchema from @atlas/config
export const todoItemSchema = BaseTodoItemSchema;

// ============================================================================
// Input Schemas
// ============================================================================

export const storeTodosSchema = z.object({
  todos: z.array(todoItemSchema).meta({ description: "Complete todo list to store" }),
}).meta({ description: "Todo list data to store" });

// ============================================================================
// Response Schemas
// ============================================================================

export const todoListResponseSchema = z.object({
  success: z.boolean(),
  todos: z.array(todoItemSchema),
  todoCount: z.number(),
}).meta({ description: "Todo list response" });

export const storeResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  error: z.string().optional(),
}).meta({ description: "Store todos response" });

export const deleteResponseSchema = z.object({
  success: z.boolean(),
  deleted: z.boolean().optional(),
  error: z.string().optional(),
}).meta({ description: "Delete todos response" });

export const streamListResponseSchema = z.object({
  success: z.boolean(),
  streams: z.array(z.string()),
  total: z.number(),
}).meta({ description: "Stream list response" });

export const errorResponseSchema = z.object({
  error: z.string(),
}).meta({ description: "Standard error response" });

// ============================================================================
// Type Exports
// ============================================================================

export type TodoItem = z.infer<typeof todoItemSchema>;
export type StoreTodosRequest = z.infer<typeof storeTodosSchema>;
export type TodoListResponse = z.infer<typeof todoListResponseSchema>;
export type StoreResponse = z.infer<typeof storeResponseSchema>;
export type DeleteResponse = z.infer<typeof deleteResponseSchema>;
export type StreamListResponse = z.infer<typeof streamListResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
