/** Audio and video files that file transcription accepts. */
export const MEDIA_EXTENSIONS = [
  "mp3",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "oga",
  "opus",
  "flac",
  "wma",
  "webm",
  "mkv",
  "mp4",
  "m4v",
  "mov",
  "avi",
  "wmv",
];

export const isMediaPath = (path: string): boolean => {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return MEDIA_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
};
