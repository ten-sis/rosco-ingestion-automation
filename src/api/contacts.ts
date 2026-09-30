/**
 * Contact resource client: search, create, read, and enabled-state patch.
 */
import type { ApiClient } from './client';
import type { Contact, Uuid } from '../types';

/** The contact fields the API can actually return. See `Contact` in `types.ts` for why
 * `deleted_at` is not one of them and is attached separately, by `withConfirmedNotDeleted`. */
type ApiContactFields = Omit<Contact, 'deleted_at'>;

interface ContactSearchResponse {
  results: ApiContactFields[];
}

/**
 * Attaches the `deleted_at: null` invariant documented on `Contact` in `types.ts`: the field is
 * not a real, returnable API field at all, and every `Contact` this suite's own client code can
 * ever build is provably live (paranoid model default exclusion, and nothing here ever
 * soft-deletes a contact) — so this is the one honest way to populate a field the API cannot send,
 * rather than trusting whatever key happened to be in the raw JSON response.
 */
function withConfirmedNotDeleted(raw: ApiContactFields): Contact {
  return { ...raw, deleted_at: null };
}

/** One page's worth of `POST /v5/contacts/search`. */
const SEARCH_PAGE_SIZE = 200;

/**
 * Hard cap on how many contacts `fetchAllContacts` will scan before giving up. An account this
 * large almost certainly means the fixture drivers should be found some other way (e.g. by id,
 * once provisioning records one), not that the cap should simply grow.
 */
const MAX_CONTACTS_SCANNED = 2000;

/**
 * The `fields` this suite needs back from every contact row. `POST /v5/contacts/search`'s
 * `fields` schema (`contact/v5/schema.js:47`, `FIELDS(schemaV4.CONTACT_FIELDS, ["id"])`) defaults
 * to `["id"]` when the key is omitted entirely (defect C2) — the previous version of this call
 * sent no `fields` at all, so every row came back as `{ id }` and `c.first_name.toLowerCase()`
 * threw a raw TypeError on `undefined` inside `ensureContacts` on any account that already had
 * contacts. `CONTACT_FIELDS` (`contact/v4/schema.js:114`, `[...READONLY_FIELDS,
 * ...Object.keys(contactProperties)]`) does carry `first_name`, `last_name` and `enabled`; it has
 * no `deleted_at` (see the doc comment on `Contact` in `types.ts` for why that field was dropped
 * from the type rather than requested here).
 */
const CONTACT_SEARCH_FIELDS = ['id', 'first_name', 'last_name', 'email', 'enabled'] as const;

/**
 * Pages `POST /v5/contacts/search` to exhaustion, or until `MAX_CONTACTS_SCANNED` is hit.
 *
 * VERIFY: contact/v4/schema.js's Filters (email, id, type, tags, is_laborer, status,
 * supervisor_id) has no `name` key, so server-side name filtering is unconfirmed and this still
 * filters client-side. Pagination is assumed to be `limit`/`offset`, mirroring `GET /v5/trips`
 * (trip/v4/schema.js's `QuerySchema`) -- confirm on the first live run.
 *
 * Finding 7: the previous version read a single page of 200 and filtered client-side. On an
 * account with more than 200 contacts the four fixture drivers were invisible, provisioning
 * created duplicates every run, and which duplicate a later run picked depended on server
 * ordering. Paginating to exhaustion removes all three failure modes; the hard cap turns "quietly
 * wrong on a big account" into a loud, actionable failure instead.
 */
async function fetchAllContacts(api: ApiClient): Promise<Contact[]> {
  const pages: Contact[][] = [];
  let offset = 0;
  for (;;) {
    const response = await api.post<ContactSearchResponse>('/v5/contacts/search', {
      fields: CONTACT_SEARCH_FIELDS,
      limit: SEARCH_PAGE_SIZE,
      offset,
    });
    pages.push(response.results.map(withConfirmedNotDeleted));
    offset += response.results.length;
    if (response.results.length < SEARCH_PAGE_SIZE) break;
    if (offset >= MAX_CONTACTS_SCANNED) {
      throw new Error(
        `fetchAllContacts: scanned ${offset} contacts without exhausting the account's contact ` +
          `list (cap is ${MAX_CONTACTS_SCANNED}). Either this account is unexpectedly large for a ` +
          'fixture run, or pagination is not actually advancing.',
      );
    }
  }
  return pages.flat();
}

/**
 * Searches contacts and filters client-side for ones whose first or last name starts with
 * the prefix. See `fetchAllContacts` for the pagination and its VERIFY note.
 */
export async function searchContactsByName(api: ApiClient, namePrefix: string): Promise<Contact[]> {
  const prefix = namePrefix.toLowerCase();
  const all = await fetchAllContacts(api);
  return all.filter(
    (c: Contact) => c.first_name.toLowerCase().startsWith(prefix) || c.last_name.toLowerCase().startsWith(prefix),
  );
}

/**
 * Creates a fixture contact and returns its id.
 *
 * VERIFY: contact/v4/schema.js:138-148 (reused by v5) requires `type` + `first_name` + `tags`
 * (or `type` + `name`) on POST /v5/contacts, a plain object body (not array-wrapped, unlike
 * assets/trackers). Using type "craft" with an empty tags array as the fixture default —
 * confirm this account's contact-type configuration accepts it.
 */
export async function createContact(api: ApiClient, first: string, last: string, email: string): Promise<Uuid> {
  const contact = await api.post<ApiContactFields>('/v5/contacts', {
    type: 'craft',
    first_name: first,
    last_name: last,
    email,
    tags: [],
  });
  return contact.id;
}

/** Reads a contact by id. */
export async function getContact(api: ApiClient, id: Uuid): Promise<Contact> {
  const contact = await api.get<ApiContactFields>(`/v5/contacts/${id}`);
  return withConfirmedNotDeleted(contact);
}

/**
 * PATCH /v5/contacts takes no id segment: the body is an array, and each element carries its
 * own id. Confirmed at contact/v5/index.js:40 (`router.patch("/", ...)`) and
 * contact/v4/schema.js:150-161 (`patch` schema: `type: "array"`, each item `required: ["id"]`).
 *
 * Every update fails with 400 "Must have email or phone" on a contact that has neither
 * (`Contact.js`'s `beforeUpdate` hook), so an update that adds the missing email has to carry it
 * in this same body.
 */
export async function patchContact(
  api: ApiClient,
  id: Uuid,
  changes: { enabled?: boolean; email?: string },
): Promise<void> {
  await api.patch<void>('/v5/contacts', [{ id, ...changes }]);
}

/**
 * Soft-deletes contacts. DELETE /v5/contacts takes no id segment: the body is the array of ids
 * (contact/v4/controller.js `destroy`, `where: { id: req.body }`).
 */
export async function deleteContacts(api: ApiClient, ids: readonly Uuid[]): Promise<void> {
  await api.delete<void>('/v5/contacts', undefined, ids);
}

/**
 * Finds a contact by exact name, including soft-deleted ones. `include_deleted` makes the search
 * drop Sequelize's paranoid filter and return `deleted_at` (contact/v5/service.js `searchPost`).
 */
export async function findContactIncludingDeleted(
  api: ApiClient,
  first: string,
  last: string,
): Promise<(Contact & { deleted_at: string | null }) | undefined> {
  for (let offset = 0; offset < MAX_CONTACTS_SCANNED; offset += SEARCH_PAGE_SIZE) {
    const response = await api.post<{ results: Array<ApiContactFields & { deleted_at?: string | null }> }>(
      '/v5/contacts/search',
      { fields: CONTACT_SEARCH_FIELDS, include_deleted: true, limit: SEARCH_PAGE_SIZE, offset },
    );
    const match = response.results.find((c) => c.first_name === first && c.last_name === last);
    if (match) return { ...match, deleted_at: match.deleted_at ?? null } as Contact & { deleted_at: string | null };
    if (response.results.length < SEARCH_PAGE_SIZE) return undefined;
  }
  return undefined;
}

/** Enables or disables a contact. The contact must already have an email or mobile phone. */
export async function setContactEnabled(api: ApiClient, id: Uuid, enabled: boolean): Promise<void> {
  await patchContact(api, id, { enabled });
}
