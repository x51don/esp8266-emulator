/**
 * Shared drag-and-drop contract between the palette and the schematic
 * canvas (audit H1: the MIME key used to be duplicated in both files).
 */
export const COMPONENT_MIME = 'application/x-component';

/**
 * The dragged part type, mirrored in memory: browsers hide dataTransfer
 * payloads from dragover, but palette and canvas share this window.
 */
export const dragState: { type: string | null } = { type: null };
