import { ItemAnnotation, ItemHashTag } from '@destinyitemmanager/dim-api-types';
import { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { I18nKey, tl } from 'app/i18next-t';
import { ThunkResult } from 'app/store/types';
import { filterMap, isEmpty } from 'app/utils/collections';
import { infoLog, warnLog } from 'app/utils/log';
import { keyBy } from 'es-toolkit';
import { archiveIcon, banIcon, boltIcon, heartIcon, tagIcon } from '../shell/icons';
import { setItemNote, setItemTag, tagCleanup } from './actions';
import { DimItem } from './item-types';
import { itemInfosSelector } from './selectors';
import { DimStore } from './store-types';

// sortOrder: orders items within a bucket, ascending
export const tagConfig = {
  favorite: {
    type: 'favorite' as const,
    label: tl('Tags.Favorite'),
    sortOrder: 0,
    hotkey: 'shift+1',
    icon: heartIcon,
  },
  keep: {
    type: 'keep' as const,
    label: tl('Tags.Keep'),
    sortOrder: 1,
    hotkey: 'shift+2',
    icon: tagIcon,
  },
  junk: {
    type: 'junk' as const,
    label: tl('Tags.Junk'),
    sortOrder: 2,
    hotkey: 'shift+3',
    icon: banIcon,
  },
  infuse: {
    type: 'infuse' as const,
    label: tl('Tags.Infuse'),
    sortOrder: 3,
    hotkey: 'shift+4',
    icon: boltIcon,
  },
  archive: {
    type: 'archive' as const,
    label: tl('Tags.Archive'),
    sortOrder: 4,
    hotkey: 'shift+5',
    icon: archiveIcon,
  },
};

export type TagValue = keyof typeof tagConfig;
export type TagCommand = TagValue | 'clear';

/**
 * Priority order for which items should get moved off a character (into the vault or another character)
 * when the character is full and you want to move something new in. Tag values earlier in this list
 * are more likely to be moved.
 */
export const characterDisplacePriority: (TagValue | 'none')[] = [
  // Archived items should move to the vault
  'archive',
  // Infusion fuel belongs in the vault
  'infuse',
  'none',
  'junk',
  'keep',
  // Favorites you probably want to keep on your character
  'favorite',
];

/**
 * Priority order for which items should get moved out of the vault (onto a character)
 * when the vault is full and you want to move something new in. Tag values earlier in this list
 * are more likely to be moved.
 */
export const vaultDisplacePriority: (TagValue | 'none')[] = [
  // Junk should probably bubble towards the character so you remember to delete them!
  'junk',
  'none',
  'keep',
  // Favorites you probably want to keep in the vault if you put them there
  'favorite',
  // Infusion fuel belongs in the vault
  'infuse',
  // Archived items should absolutely stay in the vault
  'archive',
];

/**
 * Priority order for which items should get chosen to replace an equipped item.
 * Tag values earlier in this list are more likely to be chosen.
 */
export const equipReplacePriority: (TagValue | 'none')[] = [
  'favorite',
  'keep',
  'none',
  'infuse',
  'junk',
  'archive',
];

export interface ItemInfos {
  [itemId: string]: ItemAnnotation;
}

export interface TagInfo {
  type?: TagValue;
  label: I18nKey;
  sortOrder?: number;
  displacePriority?: number;
  hotkey?: string;
  icon?: string | IconDefinition;
}

// populate tag list from tag config info
export const itemTagList: TagInfo[] = Object.values(tagConfig);

export const vaultGroupTagOrder = filterMap(itemTagList, (tag) => tag.type);

export const itemTagSelectorList: TagInfo[] = [
  { label: tl('Tags.TagItem') },
  ...Object.values(tagConfig),
];

/**
 * Delete items from the loaded items that don't appear in newly-loaded stores
 */
export function cleanInfos(stores: DimStore[]): ThunkResult {
  return async (dispatch, getState) => {
    if (!stores.length || stores.some((s) => s.items.length === 0 || s.hadErrors)) {
      // don't accidentally wipe out notes
      return;
    }

    const infos = itemInfosSelector(getState());

    if (isEmpty(infos)) {
      return;
    }

    const infosWithCraftedDate = Object.values(infos).filter((i) => i.craftedDate);
    const infosByCraftedDate = keyBy(infosWithCraftedDate, (i) => i.craftedDate!);

    let maxItemId = 0n;

    // Tags/notes are stored keyed by instance ID. Start with all the keys of the
    // existing tags and notes and remove the ones that are still here, and the rest
    // should be cleaned up because they refer to deleted items.
    const cleanupIds = new Set(Object.keys(infos));
    for (const store of stores) {
      for (const item of store.items) {
        const itemId = BigInt(item.id);
        if (itemId > maxItemId) {
          maxItemId = itemId;
        }
        const info = infos[item.id];
        if (info && (info.tag !== undefined || info.notes?.length)) {
          cleanupIds.delete(item.id);
        } else if (item.craftedInfo?.craftedDate) {
          // Double-check crafted items - we may have them under a different ID.
          // If so, patch up the data by re-tagging them under the new ID.
          // We'll delete the old item's info, but the new infos will be saved.
          const craftedInfo = infosByCraftedDate[item.craftedInfo.craftedDate];
          if (craftedInfo) {
            if (craftedInfo.tag) {
              dispatch(
                setItemTag({
                  itemId: item.id,
                  tag: craftedInfo.tag,
                  craftedDate: item.craftedInfo.craftedDate,
                }),
              );
            }
            if (craftedInfo.notes) {
              dispatch(
                setItemNote({
                  itemId: item.id,
                  note: craftedInfo.notes,
                  craftedDate: item.craftedInfo.craftedDate,
                }),
              );
            }
          }
        }
      }
    }

    if (cleanupIds.size > 0) {
      const eligibleCleanupIds = Array.from(cleanupIds).filter((id) => BigInt(id) < maxItemId);
      if (cleanupIds.size > eligibleCleanupIds.length) {
        warnLog(
          'cleanInfos',
          `${cleanupIds.size - eligibleCleanupIds.length} infos have IDs newer than the newest ID in inventory`,
        );
      }
      if (eligibleCleanupIds.length > 0) {
        infoLog('cleanInfos', `Purging tag/notes from ${eligibleCleanupIds.length} deleted items`);
        dispatch(tagCleanup(eligibleCleanupIds));
      }
    }
  };
}

export function getTag(
  item: DimItem,
  itemInfos: ItemInfos,
  itemHashTags?: {
    [itemHash: string]: ItemHashTag;
  },
): TagValue | undefined {
  return item.taggable
    ? (item.instanced ? itemInfos[item.id]?.tag : itemHashTags?.[item.hash]?.tag) || undefined
    : undefined;
}

export function getNotes(
  item: DimItem,
  itemInfos: ItemInfos,
  itemHashTags?: {
    [itemHash: string]: ItemHashTag;
  },
): string | undefined {
  return item.taggable
    ? (item.instanced ? itemInfos[item.id]?.notes : itemHashTags?.[item.hash]?.notes) || undefined
    : undefined;
}
