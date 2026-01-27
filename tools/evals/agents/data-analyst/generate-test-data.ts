/**
 * Generate simple sales data for testing the Data Analyst agent.
 * Creates deterministic data that's easy to verify with known aggregations.
 */

import { writeFile } from "node:fs/promises";
import Papa from "papaparse";

interface SalesRecord {
  date: string;
  region: string;
  product: string;
  quantity: number;
  unit_price: number;
  revenue: number;
}

const REGIONS = ["North", "South", "East", "West"] as const;
const PRODUCTS = ["Widget A", "Widget B", "Widget C"] as const;

/**
 * Generate deterministic sales data with known aggregations.
 * Uses fixed seed patterns for verifiable results.
 */
export function generateSalesData(recordCount = 100): SalesRecord[] {
  const records: SalesRecord[] = [];

  // Fixed date range: 2024-Q4 (Oct-Dec)
  const dates = [
    "2024-10-01",
    "2024-10-15",
    "2024-11-01",
    "2024-11-15",
    "2024-12-01",
    "2024-12-15",
  ];

  // Generate records with predictable distribution
  for (let i = 0; i < recordCount; i++) {
    const region = REGIONS[i % REGIONS.length] ?? "North";
    const product = PRODUCTS[i % PRODUCTS.length] ?? "Widget A";
    const date = dates[i % dates.length] ?? "2024-12-01";

    // Deterministic pricing based on product
    const unitPrice = product === "Widget A" ? 10 : product === "Widget B" ? 25 : 50;

    // Quantity varies by region for testable patterns
    // North: high volume, South: medium, East: low, West: medium-high
    const baseQty =
      region === "North" ? 100 : region === "South" ? 50 : region === "East" ? 25 : 75;
    const quantity = baseQty + (i % 10);

    records.push({
      date,
      region,
      product,
      quantity,
      unit_price: unitPrice,
      revenue: quantity * unitPrice,
    });
  }

  return records;
}

/**
 * Calculate expected aggregations for test verification.
 */
export function calculateExpectedAggregations(records: SalesRecord[]) {
  const totalRevenue = records.reduce((sum, r) => sum + r.revenue, 0);
  const totalQuantity = records.reduce((sum, r) => sum + r.quantity, 0);
  const recordCount = records.length;

  // Revenue by region
  const revenueByRegion = new Map<string, number>();
  for (const r of records) {
    revenueByRegion.set(r.region, (revenueByRegion.get(r.region) ?? 0) + r.revenue);
  }

  // Revenue by product
  const revenueByProduct = new Map<string, number>();
  for (const r of records) {
    revenueByProduct.set(r.product, (revenueByProduct.get(r.product) ?? 0) + r.revenue);
  }

  // Top region by revenue
  let topRegion = "";
  let topRegionRevenue = 0;
  for (const [region, revenue] of revenueByRegion) {
    if (revenue > topRegionRevenue) {
      topRegion = region;
      topRegionRevenue = revenue;
    }
  }

  return {
    totalRevenue,
    totalQuantity,
    recordCount,
    revenueByRegion: Object.fromEntries(revenueByRegion),
    revenueByProduct: Object.fromEntries(revenueByProduct),
    topRegion,
    topRegionRevenue,
  };
}

/**
 * Write sales data to CSV file.
 */
export async function generateSalesCSV(outputPath: string, recordCount = 100): Promise<void> {
  const records = generateSalesData(recordCount);
  const csv = Papa.unparse(records);
  await writeFile(outputPath, csv, "utf-8");

  const expected = calculateExpectedAggregations(records);
  console.log(`Generated ${recordCount} sales records at ${outputPath}`);
  console.log(`Expected aggregations:`);
  console.log(`  Total revenue: $${expected.totalRevenue.toLocaleString()}`);
  console.log(`  Total quantity: ${expected.totalQuantity.toLocaleString()}`);
  console.log(
    `  Top region: ${expected.topRegion} ($${expected.topRegionRevenue.toLocaleString()})`,
  );
}
