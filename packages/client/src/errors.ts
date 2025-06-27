/**
 * Custom error class for Atlas API errors
 */
export class AtlasApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "AtlasApiError";
  }
}
