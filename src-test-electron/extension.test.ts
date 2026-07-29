import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Copy Content with Tree Extension Host', () => {
  test('activates and registers the four command ids', async () => {
    const ext = vscode.extensions.getExtension('xaya1001.copy-content-with-tree');
    assert.ok(ext, 'extension should be discoverable');
    await ext.activate();
    assert.strictEqual(ext.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'copyContentWithTree.copy',
      'copyContentWithTree.copyTree',
      'copyContentWithTree.copyDiff',
      'copyContentWithTree.debugSelection',
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });
});
