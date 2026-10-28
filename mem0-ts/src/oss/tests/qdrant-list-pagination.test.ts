/// <reference types="jest" />
/**
 * Entity-store reads must cover the whole scope, not the first 10k rows (#7763).
 * Fully mocked — the scroll mock honors limit/offset like a real Qdrant server.
 */

type Row = { id: string; payload: Record<string, any> };

function buildMockClient(rows: Row[]) {
  return {
    createCollection: jest.fn().mockResolvedValue(undefined),
    createPayloadIndex: jest.fn().mockResolvedValue(undefined),
    getCollection: jest
      .fn()
      .mockResolvedValue({ config: { params: { vectors: { size: 4 } } } }),
    delete: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    scroll: jest.fn(async (_name: string, req: any) => {
      const start = req.offset ?? 0;
      const points = rows.slice(start, start + req.limit);
      const next = start + req.limit;
      return { points, next_page_offset: next < rows.length ? next : null };
    }),
  };
}

jest.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: jest.fn(),
}));

import { Qdrant } from "../src/vector_stores/qdrant";
import { Memory } from "../src/memory";

function makeStore(client: ReturnType<typeof buildMockClient>) {
  return new Qdrant({
    client: client as any,
    collectionName: "test",
    embeddingModelDims: 4,
    dimension: 4,
  } as any);
}

const makeRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `e${i}`,
    payload: { data: `entity ${i}`, linkedMemoryIds: ["other"] },
  }));

describe("Qdrant.list pagination", () => {
  it("follows next_page_offset until topK rows are read", async () => {
    const client = buildMockClient(makeRows(2500));
    const [rows, count] = await makeStore(client).list(undefined, 2200);
    expect(count).toBe(2200);
    expect(rows[2199].id).toBe("e2199");
    expect(client.scroll).toHaveBeenCalledTimes(3);
  });

  it("stops when Qdrant has no next page", async () => {
    const client = buildMockClient(makeRows(10));
    const [rows] = await makeStore(client).list(undefined, 100);
    expect(rows).toHaveLength(10);
    expect(client.scroll).toHaveBeenCalledTimes(1);
  });
});

describe("Memory entity cleanup past 10k rows", () => {
  it("removes a deleted memory from entity rows beyond the first 10k", async () => {
    const rows = makeRows(10000);
    rows.push({
      id: "e10000",
      payload: { data: "late", linkedMemoryIds: ["mem-1"] },
    });
    const client = buildMockClient(rows);
    const store = makeStore(client);
    const fakeThis = {
      getEntityStore: async () => store,
      embedder: { embed: async () => [0, 0, 0, 1] },
      _listEntityScope: (Memory.prototype as any)._listEntityScope,
    };

    await (Memory.prototype as any)._removeMemoryFromEntityStore.call(
      fakeThis,
      "mem-1",
      { userId: "u" },
    );

    expect(client.delete).toHaveBeenCalledWith("test", { points: ["e10000"] });
  });
});
