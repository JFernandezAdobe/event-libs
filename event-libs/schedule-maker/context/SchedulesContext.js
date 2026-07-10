/* eslint-disable max-len */
import { createContext, useState, useContext, useCallback, useEffect, useMemo } from '../../v1/deps/htm-preact.js';
import { html } from '../htm-wrapper.js';
import {
  getSchedules as getSchedulesController,
  createSchedule as createScheduleController,
  updateSchedule as updateScheduleController,
  deleteSchedule as deleteScheduleController,
  syncSchedules as syncSchedulesController,
  findScheduleReferences,
  getScheduleRefs as getScheduleRefsController,
  propagateScheduleToDocs,
} from '../scripts/da-controller.js';
import {
  processSchedules,
  assignIdToBlocks,
  isBlockComplete,
  isScheduleComplete,
  prepareScheduleForServer,
  prepareScheduleForClient,
  validateSchedule,
} from '../utils.js';
import { useDA } from './DAContext.js';
import { useNavigation } from './NavigationContext.js';

const SchedulesContext = createContext();

const SchedulesProvider = ({ children }) => {
  const { org, repo } = useDA();
  const { setHasUnsavedChanges } = useNavigation();

  const [eventFolder, setEventFolder] = useState(() => localStorage.getItem('sm-last-event-folder') || null);
  const [schedules, setSchedules] = useState([]);
  const [originalActiveSchedule, setOriginalActiveSchedule] = useState(null);
  const [activeSchedule, setActiveScheduleState] = useState(null);
  const [toastSuccess, setToastSuccess] = useState(null);

  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState(null);
  const [toastError, setToastError] = useState(null);

  const hasUnsavedChanges = useMemo(() => {
    const original = JSON.stringify(prepareScheduleForServer(originalActiveSchedule));
    const current = JSON.stringify(prepareScheduleForServer(activeSchedule));
    return original !== current;
  }, [originalActiveSchedule, activeSchedule]);

  useEffect(() => {
    setHasUnsavedChanges(hasUnsavedChanges);
  }, [hasUnsavedChanges, setHasUnsavedChanges]);

  const getSchedules = useCallback(async () => {
    if (!org || !repo || !eventFolder) return;
    setIsInitialLoading(true);
    setError(null);
    try {
      const result = await getSchedulesController(org, repo, eventFolder);
      if (!result.ok) {
        setError(result.status === 403 ? 'You do not have access to this repo.' : (result.error || 'Failed to load schedules'));
        return;
      }
      const sorted = processSchedules(result.data || []);
      setSchedules(sorted);
    } catch (err) {
      setError(err.message || 'Failed to get schedules');
    } finally {
      setIsInitialLoading(false);
    }
  }, [org, repo, eventFolder]);

  const setActiveScheduleWithOriginal = useCallback((schedule) => {
    if (schedule) {
      assignIdToBlocks(schedule);
      localStorage.setItem('sm-last-schedule-id', schedule.scheduleId);
    } else {
      localStorage.removeItem('sm-last-schedule-id');
    }
    setOriginalActiveSchedule(schedule);
    setActiveScheduleState(schedule);
  }, []);

  const createAndAddSchedule = useCallback(async (schedule) => {
    setIsCreating(true);
    setToastError(null);
    try {
      const validationErrors = validateSchedule(schedule);
      if (validationErrors.length > 0) {
        const errorMessage = validationErrors.join('\n');
        setToastError(errorMessage);
        setIsCreating(false);
        return { error: errorMessage };
      }
      const serverSchedule = prepareScheduleForServer(schedule);
      const result = await createScheduleController(org, repo, eventFolder, serverSchedule);
      if (!result.ok) {
        const msg = result.status === 403 ? 'You do not have access to this repo.' : (result.error || 'Failed to create schedule');
        setToastError(msg);
        return { error: msg };
      }
      const decorated = prepareScheduleForClient(result.data);
      setSchedules((prev) => [decorated, ...prev]);
      setToastSuccess('Schedule created successfully');
      return decorated;
    } catch (err) {
      const msg = err.message || 'Failed to create schedule';
      setToastError(msg);
      return { error: msg };
    } finally {
      setIsCreating(false);
    }
  }, [org, repo, eventFolder]);

  const updateSchedule = useCallback(async (scheduleId, schedule) => {
    setIsUpdating(true);
    setToastError(null);
    try {
      const serverSchedule = prepareScheduleForServer(schedule);
      const result = await updateScheduleController(org, repo, eventFolder, scheduleId, serverSchedule);
      if (!result.ok) {
        const msg = result.status === 403 ? 'You do not have access to this repo.' : (result.error || 'Failed to update schedule');
        setToastError(msg);
        return { error: msg };
      }
      const decorated = prepareScheduleForClient(result.data);
      setSchedules((prev) => prev.map((s) => (s.scheduleId === scheduleId ? decorated : s)));
      setActiveScheduleWithOriginal(decorated);
      setToastSuccess('Schedule updated successfully');
      return decorated;
    } catch (err) {
      const msg = err.message || 'Failed to update schedule';
      setToastError(msg);
      return { error: msg };
    } finally {
      setIsUpdating(false);
    }
  }, [org, repo, eventFolder, setActiveScheduleWithOriginal]);

  const deleteSchedule = useCallback(async (scheduleId, affectedPaths = []) => {
    setIsDeleting(true);
    setToastError(null);
    try {
      const result = await deleteScheduleController(org, repo, eventFolder, scheduleId, affectedPaths);
      if (!result.ok) {
        const msg = result.status === 403 ? 'You do not have access to this repo.' : (result.error || 'Failed to delete schedule');
        setToastError(msg);
        return { error: msg };
      }
      setSchedules((prev) => prev.filter((s) => s.scheduleId !== scheduleId));
      setActiveScheduleWithOriginal(null);
      setToastSuccess('Schedule deleted successfully');
      return true;
    } catch (err) {
      const msg = err.message || 'Failed to delete schedule';
      setToastError(msg);
      return { error: msg };
    } finally {
      setIsDeleting(false);
    }
  }, [org, repo, eventFolder, setActiveScheduleWithOriginal]);

  const syncSchedules = useCallback(async (scanPath = null) => {
    if (!org || !repo || !eventFolder) return;
    setIsInitialLoading(true);
    setToastError(null);
    try {
      const result = await syncSchedulesController(org, repo, eventFolder, scanPath);
      if (!result.ok) {
        setToastError(result.error || 'Sync failed');
        return;
      }
      const { active, draft, newlyDiscovered, movedToActive, movedToDraft } = result.data;
      const allRows = [
        ...active.map((r) => ({ ...r, status: 'active' })),
        ...draft.map((r) => ({ ...r, status: 'draft' })),
      ];
      setSchedules(processSchedules(allRows));
      const parts = [];
      if (newlyDiscovered.length) parts.push(`${newlyDiscovered.length} new`);
      if (movedToActive) parts.push(`${movedToActive} moved to active`);
      if (movedToDraft) parts.push(`${movedToDraft} moved to draft`);
      setToastSuccess(parts.length ? `Sync complete — ${parts.join(', ')}` : 'Sync complete — no changes');
    } catch (err) {
      setToastError(err.message || 'Sync failed');
    } finally {
      setIsInitialLoading(false);
    }
  }, [org, repo, eventFolder]);

  // Reverse-index lookup: which docs embed this schedule (as of the last sync).
  const getScheduleRefs = useCallback(
    (scheduleId) => getScheduleRefsController(org, repo, eventFolder, scheduleId),
    [org, repo, eventFolder],
  );

  // Rewrite the embedded schedule link in the given docs (source only, no publish).
  // `schedule` is encoded as-is, matching ScheduleURLUtility (raw activeSchedule).
  const propagateSchedule = useCallback(async (schedule, paths) => {
    setToastError(null);
    try {
      const result = await propagateScheduleToDocs(org, repo, schedule, paths);
      const { updated = [], failed = [] } = result.data || {};
      if (!result.ok) {
        setToastError(`Updated ${updated.length} page(s); ${failed.length} failed — please retry.`);
      } else {
        setToastSuccess(updated.length
          ? `Updated ${updated.length} page(s) — source only, publish each to go live`
          : 'No pages needed updating');
      }
      return result;
    } catch (err) {
      const msg = err.message || 'Failed to update pages';
      setToastError(msg);
      return { ok: false, error: msg };
    }
  }, [org, repo]);

  const updateScheduleLocally = useCallback((title) => {
    setToastError(null);
    setActiveScheduleState((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, title };
      return { ...updated, isComplete: isScheduleComplete(updated) };
    });
  }, []);

  const discardChangesToActiveSchedule = useCallback(() => {
    setActiveScheduleState(originalActiveSchedule);
    setToastError(null);
  }, [originalActiveSchedule]);

  const addBlockLocally = useCallback((block) => {
    setActiveScheduleState((prev) => {
      if (!prev) return prev;
      const updatedBlocks = [...prev.blocks, block];
      return { ...prev, blocks: updatedBlocks, isComplete: isScheduleComplete({ ...prev, blocks: updatedBlocks }) };
    });
    setToastError(null);
  }, []);

  const updateBlockLocally = useCallback((blockId, updates) => {
    setActiveScheduleState((prev) => {
      if (!prev) return prev;
      const blockToUpdate = prev.blocks.find((b) => b.id === blockId);
      if (!blockToUpdate) return prev;
      const updatedBlock = { ...blockToUpdate, ...updates };
      updatedBlock.isComplete = isBlockComplete(updatedBlock);
      const updatedBlocks = prev.blocks.map((b) => (b.id === blockId ? updatedBlock : b));
      return { ...prev, blocks: updatedBlocks, isComplete: isScheduleComplete({ ...prev, blocks: updatedBlocks }) };
    });
    setToastError(null);
  }, []);

  const deleteBlockLocally = useCallback((blockId) => {
    setActiveScheduleState((prev) => {
      if (!prev) return prev;
      const updatedBlocks = prev.blocks.filter((b) => b.id !== blockId);
      return { ...prev, blocks: updatedBlocks, isComplete: isScheduleComplete({ ...prev, blocks: updatedBlocks }) };
    });
  }, []);

  const clearToastError = useCallback(() => setToastError(null), []);
  const clearToastSuccess = useCallback(() => setToastSuccess(null), []);

  useEffect(() => {
    if (eventFolder) {
      localStorage.setItem('sm-last-event-folder', eventFolder);
      setActiveScheduleWithOriginal(null);
      getSchedules();
    }
  }, [eventFolder, getSchedules]);

  const value = {
    schedules,
    setSchedules,
    activeSchedule,
    setActiveSchedule: setActiveScheduleWithOriginal,
    eventFolder,
    setEventFolder,
    isInitialLoading,
    isCreating,
    isUpdating,
    isDeleting,
    error,
    toastError,
    clearToastError,
    setToastError,
    toastSuccess,
    clearToastSuccess,
    setToastSuccess,
    hasUnsavedChanges,
    createAndAddSchedule,
    updateSchedule,
    deleteSchedule,
    updateScheduleLocally,
    addBlockLocally,
    updateBlockLocally,
    deleteBlockLocally,
    discardChangesToActiveSchedule,
    findScheduleReferences: (scheduleId, scanPath) => findScheduleReferences(org, repo, scheduleId, scanPath),
    getScheduleRefs,
    propagateSchedule,
    syncSchedules,
  };

  return html`
    <${SchedulesContext.Provider} value=${value}>
      ${children}
    </${SchedulesContext.Provider}>
  `;
};

const useSchedules = () => useContext(SchedulesContext);

export const useSchedulesData = () => {
  const ctx = useContext(SchedulesContext);
  return {
    schedules: ctx.schedules,
    activeSchedule: ctx.activeSchedule,
    setSchedules: ctx.setSchedules,
    setActiveSchedule: ctx.setActiveSchedule,
    hasUnsavedChanges: ctx.hasUnsavedChanges,
    eventFolder: ctx.eventFolder,
    setEventFolder: ctx.setEventFolder,
  };
};

export const useSchedulesOperations = () => {
  const ctx = useContext(SchedulesContext);
  return {
    createAndAddSchedule: ctx.createAndAddSchedule,
    updateSchedule: ctx.updateSchedule,
    deleteSchedule: ctx.deleteSchedule,
    updateScheduleLocally: ctx.updateScheduleLocally,
    addBlockLocally: ctx.addBlockLocally,
    updateBlockLocally: ctx.updateBlockLocally,
    deleteBlockLocally: ctx.deleteBlockLocally,
    discardChangesToActiveSchedule: ctx.discardChangesToActiveSchedule,
    findScheduleReferences: ctx.findScheduleReferences,
    getScheduleRefs: ctx.getScheduleRefs,
    propagateSchedule: ctx.propagateSchedule,
    syncSchedules: ctx.syncSchedules,
  };
};

export const useSchedulesUI = () => {
  const ctx = useContext(SchedulesContext);
  return {
    isInitialLoading: ctx.isInitialLoading,
    isCreating: ctx.isCreating,
    isUpdating: ctx.isUpdating,
    isDeleting: ctx.isDeleting,
    error: ctx.error,
    toastError: ctx.toastError,
    toastSuccess: ctx.toastSuccess,
    clearToastError: ctx.clearToastError,
    clearToastSuccess: ctx.clearToastSuccess,
    setToastSuccess: ctx.setToastSuccess,
    setToastError: ctx.setToastError,
    hasUnsavedChanges: ctx.hasUnsavedChanges,
  };
};

export { SchedulesContext, SchedulesProvider, useSchedules };
