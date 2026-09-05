import type { Category } from '@slick/core';
import { categoriesAtom, channelsAtom, currentChannelAtom, type ModalField } from '../../app/atoms.ts';
import { confirmModal, openModal } from '../../shared/ui/modal.ts';
import { api, store } from '../../app/store.ts';
import { fail, toast } from '../../shared/ui/toast.ts';
import { refreshChannels, refreshCategories } from '../../app/data.ts';
import { selectChannel, loadMessages } from '../messages/channel-state.ts';

/** The category picker shared by the create and edit dialogs. */
const NEW_CATEGORY = '__new__';

function categoryField(value = ''): ModalField {
  return {
    name: 'category',
    label: 'Category',
    type: 'select',
    value,
    options: [
      { value: '', label: 'No category' },
      ...store.get(categoriesAtom).map((c) => ({ value: c.id, label: c.name })),
      { value: NEW_CATEGORY, label: '＋ New category…' },
    ],
  };
}

/**
 * Turn what the picker returned into something the API takes. `null` clears
 * the category; picking "New category…" asks for a name first.
 * @returns undefined if the prompt was cancelled
 */
async function resolveCategoryChoice(choice: string | undefined): Promise<string | null | undefined> {
  if (choice !== NEW_CATEGORY) return choice || null;
  const created = await createCategory({ select: false });
  return created ? created.id : undefined;
}

export async function createChannel(): Promise<void> {
  const values = await openModal({
    title: 'Create a channel',
    okLabel: 'Create',
    fields: [
      {
        name: 'slug',
        label: 'Name',
        placeholder: 'e.g. deploys',
        required: true,
        help: 'Lowercase letters, digits, <code>-</code> and <code>_</code>.',
      },
      { name: 'topic', label: 'Topic', placeholder: 'What is this channel about?' },
      categoryField(store.get(currentChannelAtom)?.categoryId ?? ''),
    ],
  });
  if (!values) return;
  try {
    const category = await resolveCategoryChoice(values.category);
    if (category === undefined) return;
    const channel = await api.createChannel({ slug: values.slug ?? '', topic: values.topic, category });
    await refreshChannels();
    await selectChannel(channel.slug);
    toast(`Created #${channel.slug}`);
  } catch (err) {
    fail(err, 'Could not create that channel');
  }
}

export async function editChannel(): Promise<void> {
  const channel = store.get(currentChannelAtom);
  if (!channel) return;
  const values = await openModal({
    title: `Edit #${channel.slug}`,
    fields: [
      { name: 'slug', label: 'Name', value: channel.slug, required: true },
      { name: 'topic', label: 'Topic', value: channel.topic },
      { name: 'purpose', label: 'Purpose', type: 'textarea', value: channel.purpose, rows: 3 },
      categoryField(channel.categoryId ?? ''),
    ],
  });
  if (!values) return;
  try {
    const category = await resolveCategoryChoice(values.category);
    if (category === undefined) return;
    const updated = await api.updateChannel(channel.id, {
      slug: values.slug,
      name: values.slug,
      topic: values.topic,
      purpose: values.purpose,
      category,
    });
    await refreshChannels();
    store.set(currentChannelAtom, store.get(channelsAtom).find((c) => c.id === updated.id) ?? updated);
    toast('Channel updated');
  } catch (err) {
    fail(err, 'Could not update that channel');
  }
}

export async function toggleArchive(): Promise<void> {
  const channel = store.get(currentChannelAtom);
  if (!channel) return;
  try {
    await api.archiveChannel(channel.id, !channel.archived);
    await refreshChannels();
    store.set(currentChannelAtom, store.get(channelsAtom).find((c) => c.id === channel.id) ?? null);
    toast(channel.archived ? `#${channel.slug} restored` : `#${channel.slug} archived`);
  } catch (err) {
    fail(err, 'Could not archive that channel');
  }
}

export async function deleteChannel(): Promise<void> {
  const channel = store.get(currentChannelAtom);
  if (!channel) return;
  const count = channel.messageCount ?? 0;
  const okay = await confirmModal({
    title: `Delete #${channel.slug}?`,
    body: 'The channel and everything in it goes away for good.',
    note: count > 0 ? `${count} message${count === 1 ? '' : 's'} will be deleted too.` : undefined,
    okLabel: 'Delete channel',
  });
  if (!okay) return;
  try {
    await api.deleteChannel(channel.id, true);
    await refreshChannels();
    const next = store.get(channelsAtom).find((c) => !c.archived);
    store.set(currentChannelAtom, null);
    if (next) await selectChannel(next.slug);
    else await loadMessages();
    toast(`Deleted #${channel.slug}`);
  } catch (err) {
    fail(err, 'Could not delete that channel');
  }
}

/** A drop on a rail section. No optimistic move: the `channel.updated` frame redraws. */
export async function moveChannel(channelId: string, categoryId: string | null): Promise<void> {
  const channel = store.get(channelsAtom).find((c) => c.id === channelId);
  if (!channel || channel.categoryId === categoryId) return;
  try {
    await api.updateChannel(channel.id, { category: categoryId });
  } catch (err) {
    fail(err, 'Could not move that channel');
  }
}

/**
 * @param opts `select: false` when this is a step inside another dialog
 *   rather than the thing the user asked for.
 */
export async function createCategory({ select = true }: { select?: boolean } = {}): Promise<Category | null> {
  const values = await openModal({
    title: 'New category',
    okLabel: 'Create',
    fields: [
      {
        name: 'name',
        label: 'Name',
        placeholder: 'e.g. Engineering',
        required: true,
        help: 'A section in the sidebar. Channels can be dragged in and out of it.',
      },
    ],
  });
  if (!values) return null;
  try {
    const category = await api.createCategory({ name: values.name ?? '' });
    await refreshCategories();
    if (select) toast(`Created ${category.name}`);
    return category;
  } catch (err) {
    fail(err, 'Could not create that category');
    return null;
  }
}

export async function editCategory(category: Category): Promise<void> {
  const categories = store.get(categoriesAtom);
  const others = categories.filter((c) => c.id !== category.id);
  const index = categories.findIndex((c) => c.id === category.id);
  const values = await openModal({
    title: `Edit ${category.name}`,
    fields: [
      { name: 'name', label: 'Name', value: category.name, required: true },
      {
        name: 'after',
        label: 'Place it',
        type: 'select',
        value: index > 0 ? (categories[index - 1]?.id ?? '') : '',
        options: [
          { value: '', label: 'First' },
          ...others.map((c) => ({ value: c.id, label: `After ${c.name}` })),
        ],
      },
    ],
    extra: [{ label: 'Delete', value: 'delete', danger: true }],
  });
  if (!values) return;
  if (values._action === 'delete') return deleteCategory(category);
  try {
    if (values.name !== category.name) await api.updateCategory(category.id, { name: values.name });
    const order = others.map((c) => c.id);
    order.splice(values.after ? order.indexOf(values.after) + 1 : 0, 0, category.id);
    if (order.some((id, i) => categories[i]?.id !== id)) await api.reorderCategories(order);
    await refreshCategories();
    toast('Category updated');
  } catch (err) {
    fail(err, 'Could not update that category');
  }
}

export async function deleteCategory(category: Category): Promise<void> {
  const inside = store.get(channelsAtom).filter((c) => c.categoryId === category.id).length;
  const okay = await confirmModal({
    title: `Delete ${category.name}?`,
    body: 'The section goes away. Every channel in it stays exactly where it is.',
    note: inside > 0 ? `${inside} channel${inside === 1 ? '' : 's'} will move to "Channels".` : undefined,
    okLabel: 'Delete category',
  });
  if (!okay) return;
  try {
    await api.deleteCategory(category.id);
    await Promise.all([refreshCategories(), refreshChannels()]);
    toast(`Deleted ${category.name}`);
  } catch (err) {
    fail(err, 'Could not delete that category');
  }
}

export async function toggleCategory(category: Category): Promise<void> {
  // Optimistic: the fold should happen under the cursor, not a round trip later.
  const collapsed = !category.collapsed;
  const flip = (to: boolean) =>
    store.set(
      categoriesAtom,
      store.get(categoriesAtom).map((c) => (c.id === category.id ? { ...c, collapsed: to } : c))
    );
  flip(collapsed);
  try {
    await api.updateCategory(category.id, { collapsed });
  } catch (err) {
    flip(!collapsed);
    fail(err, 'Could not save that');
  }
}
