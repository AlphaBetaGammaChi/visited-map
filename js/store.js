/* visited-map storage layer.
 *
 * The app talks to `Store` only. Today the implementation is LocalStore
 * (localStorage + JSON export/import). To add real cloud accounts later,
 * implement the same interface against e.g. Firebase Auth + Firestore and
 * set `Store.impl = FirebaseStore` — nothing else needs to change.
 *
 * Data model:
 *   profile   = { id, name, color, createdAt }
 *   visits    = { [collectionId]: { [siteId]: isoTimestamp } }
 */

const LocalStore = {
  PREFIX: "vm:",

  _get(key, fallback) {
    try {
      const v = localStorage.getItem(this.PREFIX + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  _set(key, value) {
    localStorage.setItem(this.PREFIX + key, JSON.stringify(value));
  },

  async loadProfiles() {
    return this._get("profiles", []);
  },
  async saveProfiles(profiles) {
    this._set("profiles", profiles);
  },
  async getActiveProfileId() {
    return this._get("active", null);
  },
  async setActiveProfileId(id) {
    this._set("active", id);
  },

  async getVisits(profileId) {
    return this._get("visits:" + profileId, {});
  },
  async setVisit(profileId, collectionId, siteId, when /* iso string | null */) {
    const visits = await this.getVisits(profileId);
    visits[collectionId] = visits[collectionId] || {};
    if (when === null) delete visits[collectionId][siteId];
    else visits[collectionId][siteId] = when;
    this._set("visits:" + profileId, visits);
    return visits;
  },

  async exportProfile(profileId) {
    const profiles = await this.loadProfiles();
    return {
      app: "visited-map",
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: profiles.find((p) => p.id === profileId) || null,
      visits: await this.getVisits(profileId),
    };
  },
  async importProfile(payload) {
    if (!payload || payload.app !== "visited-map" || !payload.visits) {
      throw new Error("Not a visited-map export file");
    }
    const profiles = await this.loadProfiles();
    let id = payload.profile?.id || crypto.randomUUID();
    if (profiles.some((p) => p.id === id)) id = crypto.randomUUID();
    const profile = {
      id,
      name: (payload.profile?.name || "Imported") + " (imported)",
      color: payload.profile?.color || "#0ea5e9",
      createdAt: new Date().toISOString(),
    };
    profiles.push(profile);
    await this.saveProfiles(profiles);
    this._set("visits:" + id, payload.visits);
    return profile;
  },
};

/* Shape of a future cloud implementation (Firebase example):
 *
 * const FirebaseStore = {
 *   async loadProfiles()            -> profiles for auth.currentUser
 *   async saveProfiles(profiles)
 *   async getActiveProfileId()
 *   async setActiveProfileId(id)
 *   async getVisits(profileId)      -> from firestore `visits/{profileId}`
 *   async setVisit(pid, cid, sid, when)
 *   async exportProfile(profileId)  -> same JSON shape as LocalStore
 *   async importProfile(payload)
 * };
 */

const Store = { impl: LocalStore };
