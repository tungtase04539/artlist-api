import { config } from '../config.js';
import * as artlist from './client.js';

/**
 * Catalog model VIDEO (từ artlist) + thông số từng model. Cache theo TTL để giảm tải & tăng tốc.
 * - listVideoModels(): mọi model có feature *-to-video (bỏ image/voice/music).
 * - getModelParams(id): đủ thông số (settings) + options + default của 1 model group.
 */

let _groupsCache = { at: 0, data: null };
const _uiCache = new Map(); // modelGroupId -> { at, data }

const fresh = (e) => e && e.data && Date.now() - e.at < config.CATALOG_TTL_MS;

function pickCaps(c) {
  if (!c) return null;
  return {
    supportAudio: !!c.isSupportAudio,
    supportImageUpload: !!c.isSupportImageUpload,
    maxImageInputCount: c.maxImageInputCount ?? null,
    hasStartFrame: !!c.hasStartFrame,
    hasEndFrame: !!c.hasEndFrame,
  };
}

/** Danh sách model VIDEO. */
export async function listVideoModels() {
  if (fresh(_groupsCache)) return _groupsCache.data;
  const raw = await artlist.getModelGroups();
  const cats = raw?.result?.data?.json?.data ?? [];
  const models = [];
  for (const cat of cats) {
    for (const g of cat.modelGroups ?? []) {
      const feats = g.generationFeatures ?? [];
      if (!feats.some((f) => String(f).includes('video'))) continue; // CHỈ video
      models.push({
        modelGroupId: g.id,
        name: g.name,
        category: cat.name,
        credits: g.rating?.value ?? null, // credits cơ bản (giá thật = quote theo settings)
        features: feats,
        description: g.description ?? null,
        thumbnailUrl: g.thumbnailUrl ?? null,
        hasFreeGeneration: !!g.hasFreeGeneration,
        capabilities: pickCaps(g.defaultModelContextConfig),
      });
    }
  }
  _groupsCache = { at: Date.now(), data: models };
  return models;
}

/** Thông số (settings) đầy đủ của 1 model group. */
export async function getModelParams(modelGroupId) {
  const cached = _uiCache.get(modelGroupId);
  if (fresh(cached)) return cached.data;
  const raw = await artlist.getUIConfig(modelGroupId);
  const node = raw?.result?.data?.json;
  const data = node?.data ?? node;
  const settings = data?.settings ?? [];
  const params = settings.map((s) => ({
    name: s.setting_api_name,
    displayName: s.setting_display_name,
    type: s.setting_input_type, // string | number
    component: s.setting_component_type, // free_text | dropdown_list | image_upload ...
    required: !!s.setting_is_required,
    primary: !!s.setting_is_primary,
    options: (s.values ?? []).map((v) => ({
      value: v.value_api_name,
      label: v.value_display_name,
      default: !!v.is_default,
    })),
  }));
  const out = { modelGroupId, params };
  _uiCache.set(modelGroupId, { at: Date.now(), data: out });
  return out;
}

/** True nếu modelGroupId là model video hợp lệ. */
export async function isVideoModel(modelGroupId) {
  const models = await listVideoModels();
  return models.some((m) => m.modelGroupId === Number(modelGroupId));
}
