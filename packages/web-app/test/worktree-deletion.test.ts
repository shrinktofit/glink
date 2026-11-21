import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorktreeDeletionPhase,
  type WorktreeDeletionEvent,
  type WorktreeDeletionProgress,
  type WorktreeDeletionResult,
} from '@glink/protocol/git';
import { WorkspaceService } from '../src/workspace/workspace-service';

describe('Worktree deletion progress over HTTP', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('delivers progress before completion across split stream chunks', async () => {
    /// @case A deletion response arrives gradually, splitting JSON and UTF-8 characters.
    /// @expect Progress appears immediately; the final result is returned
    /// without replaying deletion.
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    }));
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    const progress: WorktreeDeletionProgress = {
      phase: WorktreeDeletionPhase.scan,
      worktreePath: 'C:/临时仓库/child',
      completed: 0,
      total: 2,
    };
    const onProgress = vi.fn();
    const pending = new WorkspaceService('home').deleteWorktree('token', onProgress);
    // Attach a handler immediately so a failed assertion cannot leave a rejected request behind.
    pending.catch(vi.fn());
    const bytes = new TextEncoder().encode(`${JSON.stringify({ progress })}\n`);
    const split = bytes.findIndex((byte) => byte > 127) + 1;
    stream.enqueue(bytes.slice(0, split));
    stream.enqueue(bytes.slice(split));
    const result: WorktreeDeletionResult = {
      deleted: [progress.worktreePath!],
      remaining: ['C:/临时仓库'],
      failed: { path: 'C:/临时仓库', error: 'File is busy.' },
      recordErrors: [],
    };
    try {
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(progress));
    } finally {
      stream.enqueue(new TextEncoder().encode(`${JSON.stringify({ result })}\n`));
      stream.close();
    }
    expect(await pending).toEqual(result);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/api/worktree-deletion/execute', expect.objectContaining({
      headers: expect.objectContaining({ Accept: 'application/x-ndjson' }),
    }));
  });

  it.each([
    { name: 'missing final result', end: '' },
    { name: 'partial event', end: '{"result":' },
  ])('reports an unknown outcome on $name without retrying', async ({ end }) => {
    /// @case The connection ends after progress, before a complete final result is received.
    /// @expect The caller is told the outcome is unknown and no automatic write retry occurs.
    const event: WorktreeDeletionEvent = {
      progress: { phase: WorktreeDeletionPhase.remove, completed: 0, total: 1 },
    };
    const fetch = vi.fn().mockResolvedValue(new Response(`${JSON.stringify(event)}\n${end}`));
    vi.stubGlobal('fetch', fetch);
    await expect(new WorkspaceService('home').deleteWorktree('token', vi.fn()))
      .rejects.toThrow('结果未知');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps a server refusal distinct from a broken progress connection', async () => {
    /// @case Revalidation rejects a confirmed but stale deletion plan.
    /// @expect The actual server refusal is shown instead of claiming the outcome is unknown.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(`${JSON.stringify({ error: '删除计划已失效，请重新确认。' })}\n`),
    ));
    await expect(new WorkspaceService('home').deleteWorktree('token', vi.fn()))
      .rejects.toThrow('删除计划已失效，请重新确认。');
  });

  it('reports connection loss during deletion without replaying the write', async () => {
    /// @case The HTTP body stream fails after live progress was delivered.
    /// @expect Surface an unknown outcome and issue the deletion request only once.
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    }));
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    stream.enqueue(new TextEncoder().encode(`${JSON.stringify({
      progress: { phase: WorktreeDeletionPhase.remove, completed: 0, total: 1 },
    })}\n`));
    const onProgress = vi.fn(() => stream.error(new TypeError('Connection reset.')));
    await expect(new WorkspaceService('home').deleteWorktree('token', onProgress))
      .rejects.toThrow('结果未知');
    expect(onProgress).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
