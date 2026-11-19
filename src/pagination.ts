import { sendForEnvelope, type Operation, type ResponseInfo, type Transport } from "./core";
import { VojoPaginationError } from "./errors";

export type PageMeta = { next_cursor: string | null; has_more: boolean };

export type Page<T> = { data: T[]; meta: PageMeta; lastResponse: ResponseInfo };

/**
 * Returned by every list method, and sends nothing until used.
 *
 *   for await (const screen of vojo.screens.list()) { … }   // every item, all pages
 *   const page = await vojo.screens.list({ limit: 10 });     // one page
 */
export class PagedList<T> implements AsyncIterable<T>, PromiseLike<Page<T>> {
    readonly #fetchPage: (cursor: string | undefined) => Promise<Page<T>>;
    readonly #startCursor: string | undefined;
    #firstPage: Promise<Page<T>> | undefined;

    constructor(fetchPage: (cursor: string | undefined) => Promise<Page<T>>, startCursor?: string) {
        this.#fetchPage = fetchPage;
        this.#startCursor = startCursor || undefined;
    }

    #first(): Promise<Page<T>> {
        this.#firstPage ??= this.#fetchPage(this.#startCursor);
        return this.#firstPage;
    }

    then<A = Page<T>, B = never>(
        onfulfilled?: ((page: Page<T>) => A | PromiseLike<A>) | null,
        onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
    ): Promise<A | B> {
        return this.#first().then(onfulfilled, onrejected);
    }

    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
        // Every cursor already followed: a server that hands one back (A→A, or
        // A→B→A) must never put a client into an unbounded loop.
        const seen = new Set<string>(this.#startCursor ? [this.#startCursor] : []);
        let page = await this.#first();
        for (;;) {
            yield* page.data;

            const next = page.meta?.next_cursor || undefined;
            // has_more is authoritative, even if a cursor came back as well.
            if (page.meta?.has_more === false) return;
            if (next === undefined) {
                if (page.meta?.has_more !== true) return;
                throw new VojoPaginationError("The API reported more pages (has_more) but returned no next_cursor.");
            }
            if (seen.has(next)) {
                throw new VojoPaginationError(`The API returned a cursor it had already returned (${next}). Stopping instead of looping.`);
            }
            seen.add(next);
            page = await this.#fetchPage(next);
        }
    }

    /** Collects items across pages. `limit` is required, so memory use is always a decision. */
    async toArray({ limit }: { limit: number }): Promise<T[]> {
        const items: T[] = [];
        if (limit <= 0) return items;
        for await (const item of this) {
            items.push(item);
            if (items.length >= limit) break;
        }
        return items;
    }
}

export const pagedList = <T>(transport: Transport, op: Operation): PagedList<T> => {
    const start = op.query?.cursor;
    return new PagedList<T>(
        async (cursor) => sendForEnvelope<Page<T>>(transport, { ...op, query: { ...op.query, cursor } }),
        typeof start === "string" ? start : undefined
    );
};
