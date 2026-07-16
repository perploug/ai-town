import { ServerGame } from '../hooks/serverGame.ts';

export default function AgentsOverlay({ game }: { game: ServerGame }) {
  const players = [...game.world.players.values()];

  return (
    <div
      className="absolute top-0 right-0 h-full pointer-events-none z-10 flex flex-col"
      style={{ width: '15%' }}
    >
      <div
        className="h-full flex flex-col gap-2 p-3 overflow-y-auto"
        style={{ background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(2px)' }}
      >
        <h2
          className="text-xs font-bold uppercase tracking-widest mb-1"
          style={{ color: 'rgba(255,255,255,0.6)' }}
        >
          Connected ({players.length})
        </h2>
        {players.map((player) => {
          const desc = game.playerDescriptions.get(player.id);
          const isHuman = !!player.human;
          const conversation = game.world.playerConversation(player);
          const activity =
            player.activity && player.activity.until > Date.now() ? player.activity : undefined;

          return (
            <div
              key={player.id}
              className="flex flex-col gap-0.5 rounded px-2 py-1.5"
              style={{ background: 'rgba(255,255,255,0.07)' }}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="text-xs"
                  title={isHuman ? 'Human' : 'AI Agent'}
                >
                  {isHuman ? '👤' : '🤖'}
                </span>
                <span
                  className="text-sm font-semibold truncate"
                  style={{ color: isHuman ? '#fcd34d' : '#86efac' }}
                >
                  {desc?.name ?? player.id}
                </span>
              </div>
              {activity && (
                <span className="text-xs truncate" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  {activity.emoji} {activity.description}
                </span>
              )}
              {conversation && (
                <span className="text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  💬 in conversation
                </span>
              )}
            </div>
          );
        })}
        {players.length === 0 && (
          <span className="text-xs" style={{ color: 'rgba(255,255,255,0.35)' }}>
            No players yet
          </span>
        )}
      </div>
    </div>
  );
}
