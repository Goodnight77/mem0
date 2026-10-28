/// <reference types="jest" />
/**
 * Several operators on one metadata field must all reach Qdrant (#7762).
 * Fully mocked — no real Qdrant server is required.
 */

type MockClient = Record<string, jest.Mock>;

function buildMockClient(): MockClient {
  return {
    createCollection: jest.fn().mockResolvedValue(undefined),
    createPayloadIndex: jest.fn().mockResolvedValue(undefined),
    getCollection: jest
      .fn()
      .mockResolvedValue({ config: { params: { vectors: { size: 4 } } } }),
    scroll: jest.fn().mockResolvedValue({ points: [] }),
  };
}

jest.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: jest.fn().mockImplementation(() => buildMockClient()),
}));

import { Qdrant } from "../src/vector_stores/qdrant";
import { Memory } from "../src/memory";

async function sentFilter(filters: Record<string, any>) {
  const client = buildMockClient();
  const store = new Qdrant({
    client: client as any,
    collectionName: "test",
    embeddingModelDims: 4,
    dimension: 4,
  } as any);
  await store.list(filters);
  return client.scroll.mock.calls[0][1].filter;
}

describe("Qdrant: multiple operators on one field", () => {
  it("sends one condition per operator", async () => {
    const filter = await sentFilter({
      status: { ne: "archived", nin: ["deleted"] },
    });
    expect(filter.must).toEqual([
      { key: "status", match: { except: ["archived"] } },
      { key: "status", match: { except: ["deleted"] } },
    ]);
  });

  it("combines a range with non-range operators", async () => {
    const filter = await sentFilter({
      priority: { gte: 1, lte: 5, ne: 3, nin: [4] },
    });
    expect(filter.must).toEqual([
      { key: "priority", range: { gte: 1, lte: 5 } },
      { key: "priority", match: { except: [3] } },
      { key: "priority", match: { except: [4] } },
    ]);
  });

  it("still rejects unsupported operators", async () => {
    await expect(sentFilter({ status: { ne: "a", foo: "b" } })).rejects.toThrow(
      "Unsupported filter operator(s) for field 'status'",
    );
  });
});

describe("Memory._processMetadataFilters: AND on one field", () => {
  const process = (filters: Record<string, any>) =>
    (Memory.prototype as any)._processMetadataFilters.call({}, filters);

  it("keeps every operator instead of overwriting", () => {
    expect(
      process({
        AND: [{ status: { ne: "archived" } }, { status: { nin: ["deleted"] } }],
      }),
    ).toEqual({ status: { ne: "archived", nin: ["deleted"] } });
  });

  it("merges a top-level field with an AND condition on the same field", () => {
    expect(
      process({ priority: { gte: 1 }, AND: [{ priority: { lte: 5 } }] }),
    ).toEqual({ priority: { gte: 1, lte: 5 } });
  });
});
