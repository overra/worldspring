import type { ItemStack, ItemType } from "@worldspring/shared/items";

/** Sum of `type` across the store inventory (client mirror of server countOf). */
export function countOf(inventory: readonly (ItemStack | null)[], type: ItemType): number {
  let total = 0;
  for (const stack of inventory) {
    if (stack && stack.type === type) total += stack.count;
  }
  return total;
}
