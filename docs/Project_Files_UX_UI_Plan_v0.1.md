# Project files UX/UI plan v0.1

Status: proposal for product-owner review. This document describes the user experience only;
the repository contract and implementation sequence will be designed after approval.

## 1. Product intent and scope

Each Project gets a simple user-facing file library for contracts, specifications, spreadsheets,
presentations, scans, images and other working materials. The library is distinct from the
existing technical worktree file manager:

- the Project library exposes only files owned by the current Project;
- the technical manager remains the unrestricted low-level filesystem tool;
- every stored original is part of the Git repository and therefore participates in the normal
  draft, changes, commit and publication workflow;
- file extensions are not used as an upload allowlist;
- a format may be stored even when GitPM cannot render an inline preview for it.

The first version uses a flat Project library without user-created folders. This keeps filenames
and human-written references unambiguous. Files placed directly into the canonical Project file
directory by the technical manager must appear in the user-facing library after refresh. Nested
directories remain a technical-manager concern until a folder UX is designed separately.

## 2. Entry point on the Project page

Place a secondary `Files` button immediately beside or below the Project description, before the
Project metadata. It must remain visually associated with the description instead of joining the
row of editing and task-creation actions.

The button contains:

- a paperclip/file-library icon;
- the localized label `Files` / `Файлы`;
- a compact numeric badge with the current number of files, including `0` for an empty library.

The button is available for archived Projects and read-only users because viewing and downloading
remain useful. Mutation controls inside the library follow the current draft state, writer mode and
role rules.

```text
Project P-26-ABC123
Customer portal redesign
Replace the legacy partner workspace.

[ paperclip  Files  12 ]

Status: Active   Owner: Anna   Start: 01.09.2026   Due: 15.12.2026
```

The count updates optimistically after a successful upload or deletion and is reconciled on the
next workspace refresh.

## 3. Right-side file library

Clicking `Files` opens a dedicated right-side drawer over the current Project context. It does not
navigate away from the plan or discard the selected Task. Closing the drawer returns the user to
the exact previous context.

The existing 520 px editor drawer is too narrow for a useful file preview. The file drawer should
be wider: approximately 760--960 px on a desktop, capped at about 70% of the viewport. It becomes
full-screen on a narrow viewport.

Library state:

```text
+---------------------------------------------------------------+
| Project files                                      12      X   |
| [Search files...]            Sort: Name       [Upload files]  |
|                                                               |
|  [PDF]       [DOCX]      [XLSX]      [IMG]      [FILE]        |
|  Contract    Spec v3     Estimate    Scheme     Archive       |
|  2026.pdf    .docx       .xlsx       .png       .zip          |
|                                                               |
| Drop files here to upload                                     |
+---------------------------------------------------------------+
```

The default presentation is a Windows-like tile grid with the filename below each icon. Long names
wrap to two lines and expose the full name in a tooltip and accessible label. The grid supports
keyboard navigation and does not rely on icon colour alone.

Provide recognizable families rather than an icon for every extension:

- PDF;
- Word and compatible text documents;
- Excel and tabular files, including CSV;
- PowerPoint and presentations;
- images, with a safe thumbnail when available;
- text, Markdown and source files;
- archives;
- audio and video;
- a neutral generic icon for everything else.

The toolbar contains search by filename, sorting by name/date/size, refresh and `Upload files`.
Drag-and-drop into the drawer is an equivalent upload path. Selection and scroll position survive
opening a file and returning to the library.

## 4. Viewer state

A single click on a tile opens the file inside the same drawer. The header becomes a breadcrumb
`Files / <filename>` with a Back action. A shareable/deep-linkable Project URL identifies the
selected file so browser Back and direct file references work predictably.

The viewer header contains the file icon and name, size, and actions `Download`, `Rename`,
`Properties` and a destructive `Delete` action under the overflow menu.

Preview behavior:

- PDF: embedded paged PDF viewer;
- images: fit-to-window preview with zoom and original-dimensions information;
- plain text, Markdown, JSON, YAML and source: safe read-only text rendering;
- audio/video: browser-native controls for formats supported by the browser;
- DOCX, XLSX and PPTX: a generated read-only browser preview; the original file is never modified;
- archives and unknown formats: a clear unsupported-preview card with properties and Download,
  rather than attempting to execute or render arbitrary content.

Preview failures do not make the file inaccessible. The drawer keeps its name, properties and
Download action, and explains whether the format is unsupported or preview generation failed.
Potentially active HTML, SVG, scripts, macros and external document content must never execute in
the GitPM application origin.

Generated thumbnails and previews are disposable application cache, not additional committed
Project files.

## 5. File operations

### Upload

`Upload files` allows multi-selection. The drawer shows a queue with per-file progress, success and
failure states. Uploading does not close the drawer.

If a filename already exists, GitPM does not overwrite silently. The conflict dialog offers:

- `Replace current file`, preserving the file identity and references while creating a new Git
  version;
- `Upload with another name`, with an editable proposed name;
- `Cancel`.

Filenames may contain Unicode and spaces. GitPM rejects path separators, reserved names and other
filesystem-invalid names with a specific inline explanation. Names are unique within a Project
library using a case-insensitive comparison so repositories behave consistently on Windows and
case-sensitive systems.

### Files larger than 50 MB

The 50 MB threshold is a warning boundary, not a product rejection boundary. A file above the
threshold enters a separate confirmation flow before bytes are uploaded:

1. Show the exact filename and formatted size.
2. Explain that the original and later versions remain in Git history, increasing clone, fetch and
   repository storage costs.
3. Require the user to type the exact filename, case-sensitive, into a confirmation field.
4. Enable `Upload large file anyway` only after an exact match.

Several large files require separate confirmation so one typed name cannot authorize an unrelated
batch. Upload progress must remain visible and cancellation must be possible while transfer is in
progress. Repository-host or transport limits may still produce a specific error, but GitPM must
not pretend that the 50 MB warning itself is a hard limit.

### Rename

Rename opens a small focused dialog with the current name selected while keeping the extension
visible. Changing the extension displays a non-blocking warning that preview behavior may change.
The operation refuses conflicts and invalid names before making a repository change.

File references use a hidden immutable identity, so rename updates the displayed filename without
breaking links in Project text. Manually typed name-only references are resolved and canonicalized
when the field is saved.

### Delete

If a file has no references, deletion uses a standard confirmation naming the file. If references
exist, the confirmation shows their count and a short list of Tasks/comments that use the file.
The explicit action is `Delete file and unlink N references`; unlinking preserves the visible
filename as plain text instead of silently deleting surrounding prose.

Deletion removes the file from the current repository version. The dialog explains that committed
older content may remain in Git history. It must not claim secure erasure.

### Properties

Properties are shown as a compact panel with copyable values:

- filename and detected format;
- size in a human-readable form and exact bytes;
- repository-relative canonical path, for example
  `projects/P-26-ABC123/files/Specification_v3.docx`;
- date added to GitPM;
- date and author of the latest change when known;
- current draft state: unchanged, added, modified or scheduled for deletion;
- number of references inside the Project;
- preview availability.

GitPM should label dates according to their actual source. It must not present checkout filesystem
birth time as a durable creation date. Uncommitted uploads may show `Added in this draft` until a
commit timestamp exists.

## 6. File references in Project text

`@` remains reserved for people. File references use a wiki-style, locale-neutral token:

```text
According to section 5.2 [[file:Specification_v3.docx]], the acceptance period is 10 days.
```

Typing `[[` in a Project-scoped Markdown editor opens file suggestions with icon, filename and
size. A paperclip action beside the editor opens the same picker for users who do not know the
syntax. Selecting a file inserts the reference at the cursor. Search is tolerant of case and finds
any substring of the filename.

Internally the selected reference is canonicalized to a stable file identity while retaining a
human-readable label. Users may type the name-only form above; duplicate user-facing filenames are
prohibited, so resolution is deterministic.

Rendered references appear as compact inline file links with a type icon and filename. Clicking a
link opens the same right-side drawer directly in viewer state without losing the current Task or
comment context. A missing reference renders as an explicit broken-link chip with an explanation,
not as an inert link or silently changed text.

Reference support applies to every Markdown field with an unambiguous Project context, initially:

- Project description;
- Milestone description;
- Task description and acceptance criteria;
- Task comments;
- Project-scoped time-entry notes.

Global entities and text without a Project context cannot use implicit Project-file references.
Cross-Project references are outside the first version and must not silently widen scope.

## 7. Draft, Git and external-change feedback

Upload, replace, rename and delete are normal draft mutations and follow optimistic fingerprint and
writer-mode rules. Read-only roles can browse, preview, inspect properties and download, but do not
see enabled mutation controls.

The Changes UI groups file changes under the owning Project and gives them semantic labels such as
`File added`, `File replaced`, `File renamed` and `File deleted`; they must not appear as unexplained
unclassified paths. Commit and publication include the originals. Derived previews are excluded.

The user-facing library reads the actual canonical Project file directory. A regular file added,
renamed or replaced through the technical file manager becomes visible after refresh. If an
external operation creates an ambiguous filename, unsupported nesting or inconsistent metadata,
the library shows a repairable warning rather than guessing or hiding repository state.

## 8. Empty, loading and error states

- Empty: a short explanation, `Upload first file`, and a visible drop target.
- Loading: stable drawer geometry with tile skeletons; no full-page spinner.
- Uploading: per-file progress, cancel where possible, and continued access to completed items.
- Read-only/external writer: a compact warning explaining why changes are disabled.
- Offline/server error: preserve the current selection and offer Retry.
- Stale fingerprint: explain that repository content changed and refresh the library before retrying.
- Broken reference: keep surrounding text readable and offer `Find file` when the user can repair it.

Focus moves to the drawer heading when it opens and returns to the triggering control when it
closes. Escape closes menus/dialogs first, then the drawer. Destructive confirmations trap focus
and have explicit labels; tile actions are available without hover.

## 9. Proposed delivery slices after UX approval

This is not yet the technical implementation plan. It defines product slices so the later plan can
be staged and verified without shipping misleading partial behavior:

1. Project library entry point, tile drawer, upload/download, properties and native safe previews.
2. Rename/replace/delete with Git-aware change feedback and the over-50-MB confirmation flow.
3. Stable file references in Project-scoped Markdown editors and renderers.
4. Safe generated Office previews and preview-cache lifecycle.
5. External technical-manager reconciliation, accessibility/responsive polish and end-to-end
   workflows.

Slice 1 should not claim DOCX/XLSX/PPTX inline preview until slice 4 is available; before then those
formats use the honest unsupported-preview fallback.

## 10. Approval decisions

Approval of this proposal confirms these product choices:

- a Project-scoped, flat user library at first, separate from the technical manager;
- a wide right-side drawer with a tile grid and an in-drawer viewer;
- unrestricted file extensions, with safe fallback for unsupported previews;
- an explicit filename-typing warning above 50 MB, without treating 50 MB as a hard rejection;
- `[[file:filename]]` instead of `@` for human-entered references;
- hidden stable file identity so rename does not break links;
- no implicit cross-Project references;
- reference-aware delete and honest Git-history wording.
