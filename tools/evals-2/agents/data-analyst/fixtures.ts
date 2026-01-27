import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertCsvToSqlite } from "@atlas/core/artifacts/converters";
import { ArtifactStorage } from "@atlas/core/artifacts/server";

/**
 * Sales data: 4 rows, predictable aggregates
 * Total revenue: 7000 (1000+2000+1500+2500)
 * US revenue: 3000, EU revenue: 4000
 * Widget revenue: 2500, Gadget revenue: 4500
 * January revenue: 3000, February revenue: 4000
 */
export const SALES_CSV = `region,product,revenue,date
US,Widget,1000,2024-01-15
US,Gadget,2000,2024-01-16
EU,Widget,1500,2024-02-10
EU,Gadget,2500,2024-02-11`;

/**
 * Products data: for JOIN tests
 * Widget -> Electronics, Gadget -> Hardware
 */
export const PRODUCTS_CSV = `product,category,price
Widget,Electronics,50
Gadget,Hardware,75`;

/**
 * Contacts data: columns with spaces (quoting test)
 */
export const CONTACTS_CSV = `First Name,Last Name,Company Name,Email
John,Doe,Acme Corp,john@acme.com
Jane,Smith,TechCo,jane@techco.com
Bob,Wilson,StartupXYZ,bob@startupxyz.com`;

export type FixtureIds = { SALES_ID: string; PRODUCTS_ID: string; CONTACTS_ID: string };

/**
 * Creates test artifacts and returns their IDs.
 * Call once in test setup.
 */
export async function createFixtures(): Promise<FixtureIds> {
  const tmpDir = join(tmpdir(), `data-analyst-eval-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });

  const createDatabaseArtifact = async (csv: string, title: string) => {
    // Write CSV to temp file
    const csvPath = join(tmpDir, `${title.toLowerCase().replace(/\s/g, "-")}.csv`);
    await writeFile(csvPath, csv, "utf-8");

    // Convert CSV to SQLite database
    const dbPath = join(tmpDir, `${title.toLowerCase().replace(/\s/g, "-")}.db`);
    const tableName = title.toLowerCase().replace(/\s/g, "_");
    const { schema } = await convertCsvToSqlite(csvPath, dbPath, tableName);

    // Create database artifact
    const result = await ArtifactStorage.create({
      workspaceId: "eval-workspace",
      data: {
        type: "database",
        version: 1,
        data: { path: dbPath, sourceFileName: `${title}.csv`, schema },
      },
      title,
      summary: `${schema.rowCount} rows, ${schema.columns.length} columns`,
    });

    if (!result.ok) throw new Error(`Failed to create fixture: ${result.error}`);
    return result.data.id;
  };

  return {
    SALES_ID: await createDatabaseArtifact(SALES_CSV, "Sales Data"),
    PRODUCTS_ID: await createDatabaseArtifact(PRODUCTS_CSV, "Products"),
    CONTACTS_ID: await createDatabaseArtifact(CONTACTS_CSV, "Contacts"),
  };
}
