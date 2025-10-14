/**
 * Tests for CSV operations
 */

import { expect } from "jsr:@std/expect@^1.0.17";
import Papa from "npm:papaparse@5.4.1";
import type { ParsedCsvFilesMap } from "./operations.ts";
import { aggregateCsv, filterCsv, getRowsCsv, joinCsv, sortCsv } from "./operations.ts";
import type { ParsedCsvFile } from "./schemas.ts";

// Helper to narrow possibly undefined values in tests
function must<T>(value: T | undefined | null): T {
  if (value == null) {
    throw new Error("Expected value to be defined");
  }
  return value;
}

// Build ParsedCsvFile from CSV string using same PapaParse options as implementation
function fromCsv(csv: string, fileName: string): ParsedCsvFile {
  const parsed = Papa.parse<Record<string, string | number | boolean | null>>(csv, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });
  const columns =
    Array.isArray(parsed.meta.fields) && parsed.meta.fields.length > 0
      ? (parsed.meta.fields as string[])
      : parsed.data.length > 0 && parsed.data[0]
        ? Object.keys(parsed.data[0])
        : [];
  return {
    filePath: `/test/${fileName}`,
    fileName,
    columns,
    rowCount: parsed.data.length,
    data: parsed.data,
  };
}

// CSV strings for tests
const salesCsv = `id,product,amount,date\n1,Apple,100,2024-01-01\n2,Banana,50,2024-01-02\n3,Apple,200,2024-01-03\n4,Orange,150,2024-01-04`;
const productsCsv = `product,category\nApple,Fruit\nBanana,Fruit\nCarrot,Vegetable`;
// For undefined, omit the field in that row
const nullsCsv = `id,amount\n1\n2,100\n3\n4,50\n5,150`;
const largeCsv = `idx\n${Array.from({ length: 20 }, (_, i) => String(i)).join("\n")}`;

const testFile1: ParsedCsvFile = fromCsv(salesCsv, "sales.csv");
const testFile2: ParsedCsvFile = fromCsv(productsCsv, "products.csv");
const testFileWithNulls: ParsedCsvFile = fromCsv(nullsCsv, "nulls.csv");
const largeFile: ParsedCsvFile = fromCsv(largeCsv, "large.csv");

Deno.test("filterCsv - eq operator", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = filterCsv(map, {
    fileName: testFile1.fileName,
    column: "product",
    operator: "eq",
    value: "Apple",
  });

  expect(result).toHaveLength(2);
  const r0 = must(result[0]);
  const r1 = must(result[1]);
  expect(r0.product).toBe("Apple");
  expect(r1.product).toBe("Apple");
});

Deno.test("filterCsv - gt operator", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = filterCsv(map, {
    fileName: testFile1.fileName,
    column: "amount",
    operator: "gt",
    value: 100,
  });

  expect(result).toHaveLength(2);
  const gt0 = must(result[0]);
  const gt1 = must(result[1]);
  expect(gt0.amount).toBe(200);
  expect(gt1.amount).toBe(150);
});

Deno.test("filterCsv - contains operator", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = filterCsv(map, {
    fileName: testFile1.fileName,
    column: "product",
    operator: "contains",
    value: "an",
  });

  expect(result).toHaveLength(2);
  const c0 = must(result[0]);
  const c1 = must(result[1]);
  expect(c0.product).toBe("Banana");
  expect(c1.product).toBe("Orange");
});

Deno.test("filterCsv - ne operator", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = filterCsv(map, {
    fileName: testFile1.fileName,
    column: "product",
    operator: "ne",
    value: "Apple",
  });

  expect(result).toHaveLength(2);
  const products = result.map((r) => r.product);
  expect(products).toContain("Banana");
  expect(products).toContain("Orange");
});

Deno.test("filterCsv - lt operator", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = filterCsv(map, {
    fileName: testFile1.fileName,
    column: "amount",
    operator: "lt",
    value: 100,
  });

  expect(result).toHaveLength(1);
  const lt0 = must(result[0]);
  expect(lt0.amount).toBe(50);
});

Deno.test("filterCsv - gte operator", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = filterCsv(map, {
    fileName: testFile1.fileName,
    column: "amount",
    operator: "gte",
    value: 150,
  });

  expect(result).toHaveLength(2);
  const amounts = result.map((r) => r.amount);
  expect(amounts).toContain(150);
  expect(amounts).toContain(200);
});

Deno.test("filterCsv - lte operator", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = filterCsv(map, {
    fileName: testFile1.fileName,
    column: "amount",
    operator: "lte",
    value: 100,
  });

  expect(result).toHaveLength(2);
  const amounts = result.map((r) => r.amount);
  expect(amounts).toContain(50);
  expect(amounts).toContain(100);
});

Deno.test("filterCsv - startsWith operator", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = filterCsv(map, {
    fileName: testFile1.fileName,
    column: "product",
    operator: "startsWith",
    value: "Ap",
  });

  expect(result).toHaveLength(2);
  const sw0 = must(result[0]);
  const sw1 = must(result[1]);
  expect(sw0.product).toBe("Apple");
  expect(sw1.product).toBe("Apple");
});

Deno.test("filterCsv - endsWith operator", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = filterCsv(map, {
    fileName: testFile1.fileName,
    column: "product",
    operator: "endsWith",
    value: "e",
  });

  expect(result).toHaveLength(3);
  const products = result.map((r) => r.product);
  expect(products).toContain("Apple");
  expect(products).toContain("Orange");
});

Deno.test("filterCsv - invalid file name", () => {
  expect(() => {
    const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
    filterCsv(map, { fileName: "missing.csv", column: "product", operator: "eq", value: "Apple" });
  }).toThrow("Invalid file name");
});

Deno.test("filterCsv - invalid column", () => {
  expect(() => {
    const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
    filterCsv(map, {
      fileName: testFile1.fileName,
      column: "nonexistent",
      operator: "eq",
      value: "test",
    });
  }).toThrow("does not exist");
});

Deno.test("sortCsv - ascending numeric", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = sortCsv(map, { fileName: testFile1.fileName, column: "amount", direction: "asc" });

  expect(result).toHaveLength(4);
  const s0 = must(result[0]);
  const s1 = must(result[1]);
  const s2 = must(result[2]);
  const s3 = must(result[3]);
  expect(s0.amount).toBe(50);
  expect(s1.amount).toBe(100);
  expect(s2.amount).toBe(150);
  expect(s3.amount).toBe(200);
});

Deno.test("sortCsv - descending string", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = sortCsv(map, {
    fileName: testFile1.fileName,
    column: "product",
    direction: "desc",
  });

  expect(result).toHaveLength(4);
  const ds0 = must(result[0]);
  const ds3 = must(result[3]);
  expect(ds0.product).toBe("Orange");
  expect(ds3.product).toBe("Apple");
});

Deno.test("sortCsv - handles null/undefined ascending", () => {
  const map: ParsedCsvFilesMap = { [testFileWithNulls.fileName]: testFileWithNulls };
  const result = sortCsv(map, {
    fileName: testFileWithNulls.fileName,
    column: "amount",
    direction: "asc",
  });

  expect(result).toHaveLength(5);
  // undefined should come first in asc order
  const na0 = must(result[0]);
  expect(na0.amount).toBeUndefined();
});

Deno.test("sortCsv - handles null/undefined descending", () => {
  const map: ParsedCsvFilesMap = { [testFileWithNulls.fileName]: testFileWithNulls };
  const result = sortCsv(map, {
    fileName: testFileWithNulls.fileName,
    column: "amount",
    direction: "desc",
  });

  expect(result).toHaveLength(5);
  // undefined should come last in desc order
  const nd4 = must(result[4]);
  expect(nd4.amount).toBeUndefined();
});

Deno.test("sortCsv - invalid column", () => {
  expect(() => {
    const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
    sortCsv(map, { fileName: testFile1.fileName, column: "invalid", direction: "asc" });
  }).toThrow("does not exist");
});

Deno.test("joinCsv - inner join", () => {
  const map: ParsedCsvFilesMap = {
    [testFile1.fileName]: testFile1,
    [testFile2.fileName]: testFile2,
  };
  const result = joinCsv(map, {
    fileName1: testFile1.fileName,
    fileName2: testFile2.fileName,
    column1: "product",
    column2: "product",
    joinType: "inner",
  });

  expect(result).toHaveLength(3);
  const j0 = must(result[0]);
  const j2 = must(result[2]);
  expect(j0.product).toBe("Apple");
  expect(j0.category).toBe("Fruit");
  expect(j2.product).toBe("Apple");
});

Deno.test("joinCsv - prefixes colliding columns from second file", () => {
  const map: ParsedCsvFilesMap = {
    [testFile1.fileName]: testFile1,
    [testFile2.fileName]: testFile2,
  };
  const result = joinCsv(map, {
    fileName1: testFile1.fileName,
    fileName2: testFile2.fileName,
    column1: "product",
    column2: "product",
    joinType: "inner",
  });

  // 'product' exists in both files, so second file's 'product' should be prefixed
  const row = must(result[0]);
  expect(row["products.csv_product"]).toBe("Apple");
});

Deno.test("joinCsv - guarantees unique column names with multiple collisions", () => {
  // Create a file that already has a prefixed column name that would collide
  const file1Csv = `id,product,products.csv_product\n1,Apple,OldValue1\n2,Banana,OldValue2`;
  const file1 = fromCsv(file1Csv, "sales.csv");

  const map: ParsedCsvFilesMap = { [file1.fileName]: file1, [testFile2.fileName]: testFile2 };

  const result = joinCsv(map, {
    fileName1: file1.fileName,
    fileName2: testFile2.fileName,
    column1: "product",
    column2: "product",
    joinType: "inner",
  });

  // Should have 2 rows (Apple and Banana matches)
  expect(result).toHaveLength(2);
  const appleRow = must(result[0]);
  const bananaRow = must(result[1]);

  // Original columns should exist
  expect(appleRow.product).toBe("Apple");
  expect(appleRow["products.csv_product"]).toBe("OldValue1");

  // New column should get suffix to avoid collision
  expect(appleRow["products.csv_product_1"]).toBe("Apple");
  expect(appleRow.category).toBe("Fruit");

  // Verify second row as well
  expect(bananaRow.product).toBe("Banana");
  expect(bananaRow["products.csv_product"]).toBe("OldValue2");
  expect(bananaRow["products.csv_product_1"]).toBe("Banana");
  expect(bananaRow.category).toBe("Fruit");
});

Deno.test("joinCsv - invalid join columns throw", () => {
  expect(() => {
    const map: ParsedCsvFilesMap = {
      [testFile1.fileName]: testFile1,
      [testFile2.fileName]: testFile2,
    };
    joinCsv(map, {
      fileName1: testFile1.fileName,
      fileName2: testFile2.fileName,
      column1: "nonexistent",
      column2: "product",
      joinType: "inner",
    });
  }).toThrow("does not exist");
});

Deno.test("joinCsv - left join", () => {
  const map: ParsedCsvFilesMap = {
    [testFile1.fileName]: testFile1,
    [testFile2.fileName]: testFile2,
  };
  const result = joinCsv(map, {
    fileName1: testFile1.fileName,
    fileName2: testFile2.fileName,
    column1: "product",
    column2: "product",
    joinType: "left",
  });

  expect(result).toHaveLength(4);
  // Orange from file1 should be included even without match
  const orangeRow = result.find((r) => r.product === "Orange");
  expect(orangeRow?.category).toBeUndefined();
});

Deno.test("joinCsv - right join", () => {
  const map: ParsedCsvFilesMap = {
    [testFile1.fileName]: testFile1,
    [testFile2.fileName]: testFile2,
  };
  const result = joinCsv(map, {
    fileName1: testFile1.fileName,
    fileName2: testFile2.fileName,
    column1: "product",
    column2: "product",
    joinType: "right",
  });

  // Should include Carrot from file2 even without match in file1
  const carrotRow = result.find((r) => r.category === "Vegetable");
  expect(carrotRow).toBeDefined();
});

Deno.test("joinCsv - outer join", () => {
  const map: ParsedCsvFilesMap = {
    [testFile1.fileName]: testFile1,
    [testFile2.fileName]: testFile2,
  };
  const result = joinCsv(map, {
    fileName1: testFile1.fileName,
    fileName2: testFile2.fileName,
    column1: "product",
    column2: "product",
    joinType: "outer",
  });

  // Should include both Orange (unmatched from file1) and Carrot (unmatched from file2)
  const orangeRow = result.find((r) => r.product === "Orange");
  const carrotRow = result.find((r) => r.category === "Vegetable");

  expect(orangeRow).toBeDefined();
  expect(carrotRow).toBeDefined();
});

Deno.test("aggregateCsv - sum without grouping", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = aggregateCsv(map, {
    fileName: testFile1.fileName,
    aggregateColumn: "amount",
    operation: "sum",
  });

  expect(result).toHaveLength(1);
  const aSum = must(result[0]);
  expect(aSum.sum).toBe(500);
});

Deno.test("aggregateCsv - avg without grouping", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = aggregateCsv(map, {
    fileName: testFile1.fileName,
    aggregateColumn: "amount",
    operation: "avg",
  });

  expect(result).toHaveLength(1);
  const aAvg = must(result[0]);
  expect(aAvg.avg).toBe(125);
});

Deno.test("aggregateCsv - count without grouping", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = aggregateCsv(map, {
    fileName: testFile1.fileName,
    aggregateColumn: "amount",
    operation: "count",
  });

  expect(result).toHaveLength(1);
  const aCount = must(result[0]);
  expect(aCount.count).toBe(4);
});

Deno.test("aggregateCsv - min without grouping", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = aggregateCsv(map, {
    fileName: testFile1.fileName,
    aggregateColumn: "amount",
    operation: "min",
  });

  expect(result).toHaveLength(1);
  const aMin = must(result[0]);
  expect(aMin.min).toBe(50);
});

Deno.test("aggregateCsv - max without grouping", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = aggregateCsv(map, {
    fileName: testFile1.fileName,
    aggregateColumn: "amount",
    operation: "max",
  });

  expect(result).toHaveLength(1);
  const aMax = must(result[0]);
  expect(aMax.max).toBe(200);
});

Deno.test("aggregateCsv - sum with grouping", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = aggregateCsv(map, {
    fileName: testFile1.fileName,
    groupByColumn: "product",
    aggregateColumn: "amount",
    operation: "sum",
  });

  expect(result).toHaveLength(3);

  const appleGroup = result.find((r) => r.product === "Apple");
  expect(appleGroup?.sum).toBe(300);

  const bananaGroup = result.find((r) => r.product === "Banana");
  expect(bananaGroup?.sum).toBe(50);
});

Deno.test("aggregateCsv - count with grouping", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = aggregateCsv(map, {
    fileName: testFile1.fileName,
    groupByColumn: "product",
    aggregateColumn: "amount",
    operation: "count",
  });

  expect(result).toHaveLength(3);

  const appleGroup = result.find((r) => r.product === "Apple");
  expect(appleGroup?.count).toBe(2);
});

Deno.test("aggregateCsv - avg with grouping", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = aggregateCsv(map, {
    fileName: testFile1.fileName,
    groupByColumn: "product",
    aggregateColumn: "amount",
    operation: "avg",
  });

  expect(result).toHaveLength(3);
  const apple = result.find((r) => r.product === "Apple");
  const banana = result.find((r) => r.product === "Banana");
  const orange = result.find((r) => r.product === "Orange");
  expect(apple?.avg).toBe(150);
  expect(banana?.avg).toBe(50);
  expect(orange?.avg).toBe(150);
});

Deno.test("aggregateCsv - invalid aggregate column throws", () => {
  expect(() => {
    const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
    aggregateCsv(map, { fileName: testFile1.fileName, aggregateColumn: "nope", operation: "sum" });
  }).toThrow("does not exist");
});

Deno.test("getRowsCsv - basic slice", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = getRowsCsv(map, { fileName: testFile1.fileName, startRow: 1, endRow: 3 });

  expect(result).toHaveLength(2);
  const gr0 = must(result[0]);
  const gr1 = must(result[1]);
  expect(gr0.id).toBe(2);
  expect(gr1.id).toBe(3);
});

Deno.test("getRowsCsv - default endRow", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = getRowsCsv(map, { fileName: testFile1.fileName, startRow: 0 });

  // Should get 4 rows (all available, less than default 10)
  expect(result).toHaveLength(4);
});

Deno.test("getRowsCsv - default endRow returns only 10 rows on large file", () => {
  const map: ParsedCsvFilesMap = { [largeFile.fileName]: largeFile };
  const result = getRowsCsv(map, { fileName: largeFile.fileName, startRow: 0 });

  expect(result).toHaveLength(10);
  const lr0 = must(result[0]);
  const lr9 = must(result[9]);
  expect(lr0.idx).toBe(0);
  expect(lr9.idx).toBe(9);
});

Deno.test("getRowsCsv - invalid startRow", () => {
  expect(() => {
    const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
    getRowsCsv(map, { fileName: testFile1.fileName, startRow: -1 });
  }).toThrow("must be >= 0");
});

Deno.test("getRowsCsv - invalid endRow", () => {
  expect(() => {
    const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
    getRowsCsv(map, { fileName: testFile1.fileName, startRow: 5, endRow: 2 });
  }).toThrow("must be >= startRow");
});
