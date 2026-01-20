/**
 * Tests for CSV operations
 */

import Papa from "papaparse";
import { expect, it } from "vitest";
import type { ParsedCsvFilesMap } from "./operations.ts";
import { aggregateCsv, filterCsv, getRowsCsv, joinCsv, limitCsv, sortCsv } from "./operations.ts";
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

it("filterCsv - eq operator", () => {
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

it("filterCsv - gt operator", () => {
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

it("filterCsv - contains operator", () => {
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

it("filterCsv - ne operator", () => {
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

it("filterCsv - lt operator", () => {
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

it("filterCsv - gte operator", () => {
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

it("filterCsv - lte operator", () => {
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

it("filterCsv - startsWith operator", () => {
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

it("filterCsv - endsWith operator", () => {
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

it("filterCsv - invalid file name", () => {
  expect(() => {
    const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
    filterCsv(map, { fileName: "missing.csv", column: "product", operator: "eq", value: "Apple" });
  }).toThrow("Invalid file name");
});

it("filterCsv - invalid column", () => {
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

it("sortCsv - ascending numeric", () => {
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

it("sortCsv - descending string", () => {
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

it("sortCsv - handles null/undefined ascending", () => {
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

it("sortCsv - handles null/undefined descending", () => {
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

it("sortCsv - invalid column", () => {
  expect(() => {
    const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
    sortCsv(map, { fileName: testFile1.fileName, column: "invalid", direction: "asc" });
  }).toThrow("does not exist");
});

it("joinCsv - inner join", () => {
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

it("joinCsv - prefixes colliding columns from second file", () => {
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

it("joinCsv - guarantees unique column names with multiple collisions", () => {
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

it("joinCsv - invalid join columns throw", () => {
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

it("joinCsv - left join", () => {
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

it("joinCsv - right join", () => {
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

it("joinCsv - outer join", () => {
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

it("aggregateCsv - sum without grouping", () => {
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

it("aggregateCsv - avg without grouping", () => {
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

it("aggregateCsv - count without grouping", () => {
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

it("aggregateCsv - min without grouping", () => {
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

it("aggregateCsv - max without grouping", () => {
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

it("aggregateCsv - sum with grouping", () => {
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

it("aggregateCsv - count with grouping", () => {
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

it("aggregateCsv - avg with grouping", () => {
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

it("aggregateCsv - invalid aggregate column throws", () => {
  expect(() => {
    const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
    aggregateCsv(map, { fileName: testFile1.fileName, aggregateColumn: "nope", operation: "sum" });
  }).toThrow("does not exist");
});

it("getRowsCsv - basic slice", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = getRowsCsv(map, { fileName: testFile1.fileName, startRow: 1, endRow: 3 });

  expect(result).toHaveLength(2);
  const gr0 = must(result[0]);
  const gr1 = must(result[1]);
  expect(gr0.id).toBe(2);
  expect(gr1.id).toBe(3);
});

it("getRowsCsv - default endRow", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = getRowsCsv(map, { fileName: testFile1.fileName, startRow: 0 });

  // Should get 4 rows (all available, less than default 10)
  expect(result).toHaveLength(4);
});

it("getRowsCsv - default endRow returns only 10 rows on large file", () => {
  const map: ParsedCsvFilesMap = { [largeFile.fileName]: largeFile };
  const result = getRowsCsv(map, { fileName: largeFile.fileName, startRow: 0 });

  expect(result).toHaveLength(10);
  const lr0 = must(result[0]);
  const lr9 = must(result[9]);
  expect(lr0.idx).toBe(0);
  expect(lr9.idx).toBe(9);
});

it("getRowsCsv - invalid startRow", () => {
  expect(() => {
    const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
    getRowsCsv(map, { fileName: testFile1.fileName, startRow: -1 });
  }).toThrow("must be >= 0");
});

it("getRowsCsv - invalid endRow", () => {
  expect(() => {
    const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
    getRowsCsv(map, { fileName: testFile1.fileName, startRow: 5, endRow: 2 });
  }).toThrow("must be >= startRow");
});

// Edge case tests for null value handling
it("filterCsv - null values with eq operator", () => {
  const map: ParsedCsvFilesMap = { [testFileWithNulls.fileName]: testFileWithNulls };
  const result = filterCsv(map, {
    fileName: testFileWithNulls.fileName,
    column: "amount",
    operator: "eq",
    value: 100,
  });

  expect(result).toHaveLength(1);
  const r0 = must(result[0]);
  expect(r0.amount).toBe(100);
});

it("filterCsv - null values with ne operator", () => {
  const map: ParsedCsvFilesMap = { [testFileWithNulls.fileName]: testFileWithNulls };
  const result = filterCsv(map, {
    fileName: testFileWithNulls.fileName,
    column: "amount",
    operator: "ne",
    value: 100,
  });

  // All non-100 values, including nulls
  expect(result).toHaveLength(4);
});

it("filterCsv - null values with gt operator", () => {
  const map: ParsedCsvFilesMap = { [testFileWithNulls.fileName]: testFileWithNulls };
  const result = filterCsv(map, {
    fileName: testFileWithNulls.fileName,
    column: "amount",
    operator: "gt",
    value: 50,
  });

  // Only 100 and 150
  expect(result).toHaveLength(2);
  const amounts = result.map((r) => r.amount);
  expect(amounts).toContain(100);
  expect(amounts).toContain(150);
});

it("filterCsv - null values with contains operator", () => {
  const nullStringsCsv = `name,value\nAlice,100\n,200\nBob,300`;
  const nullStrings = fromCsv(nullStringsCsv, "nullstrings.csv");
  const map: ParsedCsvFilesMap = { [nullStrings.fileName]: nullStrings };

  const result = filterCsv(map, {
    fileName: nullStrings.fileName,
    column: "name",
    operator: "contains",
    value: "A",
  });

  // Only Alice
  expect(result).toHaveLength(1);
  const r0 = must(result[0]);
  expect(r0.name).toBe("Alice");
});

// Edge case tests for empty result sets
it("filterCsv - filter resulting in 0 rows", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = filterCsv(map, {
    fileName: testFile1.fileName,
    column: "amount",
    operator: "gt",
    value: 1000,
  });

  expect(result).toHaveLength(0);
});

it("aggregateCsv - aggregate on empty result", () => {
  const emptyFile = fromCsv(`id,amount\n`, "empty.csv");
  const map: ParsedCsvFilesMap = { [emptyFile.fileName]: emptyFile };

  const result = aggregateCsv(map, {
    fileName: emptyFile.fileName,
    aggregateColumn: "amount",
    operation: "sum",
  });

  expect(result).toHaveLength(1);
  const r0 = must(result[0]);
  expect(r0.sum).toBe(0);
});

it("aggregateCsv - count on empty result", () => {
  const emptyFile = fromCsv(`id,amount\n`, "empty.csv");
  const map: ParsedCsvFilesMap = { [emptyFile.fileName]: emptyFile };

  const result = aggregateCsv(map, {
    fileName: emptyFile.fileName,
    aggregateColumn: "amount",
    operation: "count",
  });

  expect(result).toHaveLength(1);
  const r0 = must(result[0]);
  expect(r0.count).toBe(0);
});

// Edge case tests for join with duplicate keys
it("joinCsv - handles duplicate keys in both files (cartesian product)", () => {
  const file1Csv = `id,product,amount\n1,Apple,100\n2,Apple,200`;
  const file2Csv = `product,category\nApple,Fruit\nApple,Dessert`;

  const file1 = fromCsv(file1Csv, "sales.csv");
  const file2 = fromCsv(file2Csv, "products.csv");
  const map: ParsedCsvFilesMap = { [file1.fileName]: file1, [file2.fileName]: file2 };

  const result = joinCsv(map, {
    fileName1: file1.fileName,
    fileName2: file2.fileName,
    column1: "product",
    column2: "product",
    joinType: "inner",
  });

  // 2 sales × 2 categories = 4 rows
  expect(result).toHaveLength(4);

  const row1 = result.find((r) => r.id === 1 && r.category === "Fruit");
  const row2 = result.find((r) => r.id === 1 && r.category === "Dessert");
  const row3 = result.find((r) => r.id === 2 && r.category === "Fruit");
  const row4 = result.find((r) => r.id === 2 && r.category === "Dessert");

  expect(row1).toBeDefined();
  expect(row2).toBeDefined();
  expect(row3).toBeDefined();
  expect(row4).toBeDefined();
});

it("joinCsv - join with empty file", () => {
  const emptyFile = fromCsv(`product,category\n`, "empty.csv");
  const map: ParsedCsvFilesMap = {
    [testFile1.fileName]: testFile1,
    [emptyFile.fileName]: emptyFile,
  };

  const result = joinCsv(map, {
    fileName1: testFile1.fileName,
    fileName2: emptyFile.fileName,
    column1: "product",
    column2: "product",
    joinType: "inner",
  });

  // Inner join with empty file = 0 results
  expect(result).toHaveLength(0);
});

it("joinCsv - left join with empty file", () => {
  const emptyFile = fromCsv(`product,category\n`, "empty.csv");
  const map: ParsedCsvFilesMap = {
    [testFile1.fileName]: testFile1,
    [emptyFile.fileName]: emptyFile,
  };

  const result = joinCsv(map, {
    fileName1: testFile1.fileName,
    fileName2: emptyFile.fileName,
    column1: "product",
    column2: "product",
    joinType: "left",
  });

  // Left join preserves all rows from file1
  expect(result).toHaveLength(4);
});

it("joinCsv - handles null join keys", () => {
  const file1Csv = `id,category\n1,A\n2,`;
  const file2Csv = `category,desc\nA,Alpha\n,Unknown`;

  const file1 = fromCsv(file1Csv, "file1.csv");
  const file2 = fromCsv(file2Csv, "file2.csv");
  const map: ParsedCsvFilesMap = { [file1.fileName]: file1, [file2.fileName]: file2 };

  const result = joinCsv(map, {
    fileName1: file1.fileName,
    fileName2: file2.fileName,
    column1: "category",
    column2: "category",
    joinType: "inner",
  });

  // Should match on both "A" and null/undefined
  expect(result.length).toBeGreaterThan(0);
  const matchedA = result.find((r) => r.category === "A");
  expect(matchedA).toBeDefined();
});

// Edge case tests for sortCsv with mixed types
it("sortCsv - handles mixed string/numeric values", () => {
  const mixedCsv = `id,value\n1,100\n2,abc\n3,50\n4,xyz`;
  const mixedFile = fromCsv(mixedCsv, "mixed.csv");
  const map: ParsedCsvFilesMap = { [mixedFile.fileName]: mixedFile };

  const result = sortCsv(map, { fileName: mixedFile.fileName, column: "value", direction: "asc" });

  expect(result).toHaveLength(4);
  // Should not crash, but order may vary between numeric and string values
  expect(result[0]).toBeDefined();
});

// Edge case tests for chained operations
it("filterCsv - can chain with baseRows parameter", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };

  // First filter
  const filtered1 = filterCsv(map, {
    fileName: testFile1.fileName,
    column: "amount",
    operator: "gt",
    value: 50,
  });

  // Second filter on result of first
  const filtered2 = filterCsv(
    map,
    { fileName: testFile1.fileName, column: "product", operator: "eq", value: "Apple" },
    filtered1,
  );

  expect(filtered2).toHaveLength(2);
  const products = filtered2.map((r) => r.product);
  expect(products.every((p) => p === "Apple")).toBe(true);
});

// Tests for limitCsv
it("limitCsv - returns all rows when maxRows >= total", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = limitCsv(map, { fileName: testFile1.fileName, maxRows: 10, random: false });

  expect(result).toHaveLength(4);
});

it("limitCsv - limits to first N rows when random=false", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = limitCsv(map, { fileName: testFile1.fileName, maxRows: 2, random: false });

  expect(result).toHaveLength(2);
  const r0 = must(result[0]);
  const r1 = must(result[1]);
  expect(r0.id).toBe(1);
  expect(r1.id).toBe(2);
});

it("limitCsv - randomly samples N rows when random=true", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };
  const result = limitCsv(map, { fileName: testFile1.fileName, maxRows: 2, random: true });

  expect(result).toHaveLength(2);
  // Should be valid rows from the original data
  const ids = result.map((r) => r.id);
  for (const id of ids) {
    expect([1, 2, 3, 4]).toContain(id);
  }
});

it("limitCsv - works with baseRows (chained)", () => {
  const map: ParsedCsvFilesMap = { [testFile1.fileName]: testFile1 };

  // First filter to get rows with amount > 50
  const filtered = filterCsv(map, {
    fileName: testFile1.fileName,
    column: "amount",
    operator: "gt",
    value: 50,
  });

  expect(filtered).toHaveLength(3);

  // Then limit to 2 rows
  const limited = limitCsv(
    map,
    { fileName: testFile1.fileName, maxRows: 2, random: false },
    filtered,
  );

  expect(limited).toHaveLength(2);
  // Should be first 2 rows from filtered result
  const l0 = must(limited[0]);
  expect(l0.amount).toBeGreaterThan(50);
});
