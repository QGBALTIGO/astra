import { useState, useMemo } from 'react';
import { LoadingSpinner } from '../../../components/LoadingSpinner';
import { ignoreError } from '../../../utils/ignore-error';
import { timeAgo } from '../utils';

export function ConversationTab({
  conversation,
  isLoadingConvo,
}: {
  conversation: Array<{ role: string; content: string; createdAt?: string }>;
  isLoadingConvo: boolean;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const filteredConversation = useMemo(() => {
    return conversation.filter((msg) => {
      if (roleFilter && msg.role !== roleFilter) return false;
      if (searchQuery && !msg.content.toLowerCase().includes(searchQuery.toLowerCase()))
        return false;
      return true;
    });
  }, [conversation, roleFilter, searchQuery]);

  const roleCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const msg of conversation) {
      counts[msg.role] = (counts[msg.role] ?? 0) + 1;
    }
    return counts;
  }, [conversation]);

  const uniqueRoles = Object.keys(roleCounts);

  const toggleExpand = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const copyMessage = (content: string) => {
    ignoreError(navigator.clipboard.writeText(content), 'clipboard.copyMessage');
  };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(filteredConversation, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `claw-conversation-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyAll = () => {
    const text = filteredConversation
      .map((m) => `[${m.role}] [${m.createdAt ?? ''}]\n${m.content}`)
      .join('\n\n--- ---\n\n');
    ignoreError(navigator.clipboard.writeText(text), 'clipboard.copyAll');
  };

  const clearFilters = () => {
    setSearchQuery('');
    setRoleFilter('');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted dark:text-dark-text-muted">
          Messages from claw_send_output and claw_complete_report. These are the claw's narrative
          log.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-mono text-gray-500">
            {filteredConversation.length === conversation.length
              ? `${conversation.length} messages`
              : `${filteredConversation.length} / ${conversation.length}`}
          </span>
          <button
            onClick={copyAll}
            className="text-xs px-2 py-1 rounded font-mono text-gray-500 border border-gray-700 hover:text-gray-300"
            title="Copy all"
          >
            📋
          </button>
          <button
            onClick={downloadJson}
            className="text-xs px-2 py-1 rounded font-mono text-gray-500 border border-gray-700 hover:text-gray-300"
            title="Download JSON"
          >
            ↓
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search messages..."
          className="flex-1 px-2 py-1 text-xs rounded bg-[#1a1a1a] border border-gray-700 text-gray-300 font-mono placeholder:text-gray-600 focus:outline-none focus:border-gray-500"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="px-2 py-1 text-xs rounded bg-[#1a1a1a] border border-gray-700 text-gray-400 font-mono focus:outline-none focus:border-gray-500"
        >
          <option value="">All roles</option>
          {uniqueRoles.map((r) => (
            <option key={r} value={r}>
              {r} ({roleCounts[r]})
            </option>
          ))}
        </select>
        {(searchQuery || roleFilter) && (
          <button
            onClick={clearFilters}
            className="text-xs px-2 py-1 rounded font-mono text-red-400 border border-red-700 hover:text-red-300"
          >
            ✕
          </button>
        )}
      </div>

      {/* Role pills */}
      {uniqueRoles.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {uniqueRoles.map((r) => (
            <button
              key={r}
              onClick={() => setRoleFilter(roleFilter === r ? '' : r)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                roleFilter === r
                  ? r === 'assistant'
                    ? 'bg-primary/10 border-primary/30 text-primary'
                    : r === 'system'
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-500'
                      : 'bg-gray-500/10 border-gray-500/30 text-gray-400'
                  : 'text-gray-500 border-gray-700 hover:border-gray-500'
              }`}
            >
              {r}: {roleCounts[r]}
            </button>
          ))}
        </div>
      )}

      {isLoadingConvo ? (
        <LoadingSpinner message="Loading..." />
      ) : filteredConversation.length === 0 ? (
        <p className="text-sm text-text-muted dark:text-dark-text-muted py-4 text-center">
          {conversation.length === 0
            ? 'No messages yet. The claw writes here when using claw_send_output or claw_complete_report.'
            : 'No messages match the current filter.'}
        </p>
      ) : (
        <div className="space-y-3">
          {filteredConversation.map((msg, i) => {
            const isLong = msg.content.length > 3000;
            const isExpanded = expanded.has(i);
            return (
              <div
                key={i}
                className={`p-4 rounded-lg border ${
                  msg.role === 'assistant'
                    ? 'bg-primary/5 border-primary/10'
                    : msg.role === 'system'
                      ? 'bg-amber-500/5 border-amber-500/10'
                      : 'bg-bg-secondary dark:bg-dark-bg-secondary border-border dark:border-dark-border'
                }`}
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-xs font-bold uppercase ${
                        msg.role === 'assistant'
                          ? 'text-primary'
                          : msg.role === 'system'
                            ? 'text-amber-500'
                            : 'text-text-muted'
                      }`}
                    >
                      {msg.role}
                    </span>
                    {msg.createdAt && (
                      <span className="text-xs text-text-muted">{timeAgo(msg.createdAt)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {isLong && (
                      <button
                        onClick={() => toggleExpand(i)}
                        className="text-xs px-1.5 py-0.5 rounded font-mono text-gray-500 border border-gray-700 hover:text-gray-300"
                      >
                        {isExpanded ? '▲' : '▼'}
                      </button>
                    )}
                    <button
                      onClick={() => copyMessage(msg.content)}
                      className="text-xs px-1.5 py-0.5 rounded font-mono text-gray-500 border border-gray-700 hover:text-gray-300"
                      title="Copy"
                    >
                      📋
                    </button>
                  </div>
                </div>
                <div className="text-sm text-text-primary dark:text-dark-text-primary whitespace-pre-wrap leading-relaxed">
                  {isLong && !isExpanded ? msg.content.slice(0, 3000) + '\n\n...' : msg.content}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
