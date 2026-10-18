interface ProjektemacherGlobals {
  maps?: Map<HTMLElement | null, unknown>;
  charts?: Record<string, unknown>;
}

interface Window {
  projektemacher?: ProjektemacherGlobals;
  anchorTop: (anchor: string) => void;
}
