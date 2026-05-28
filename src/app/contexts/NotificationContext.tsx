import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
  useRef,
  useMemo,
} from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import { useUserProfile } from '../hooks/useUserProfile';
import { toast } from 'sonner';

// ─── Types ──────────────────────────────────────────────────────────

export type NotificationType =
  | 'new_message'
  | 'new_conversation'
  | 'status_change'
  | 'assignment';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  created_at: string;
  conversation_id?: string;
  metadata?: Record<string, any>;
}

interface NotificationContextType {
  notifications: AppNotification[];
  unreadCount: number;
  addNotification: (n: AppNotification) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  deleteNotification: (id: string) => void;
  clearAll: () => void;
}

const NotificationContext = createContext<NotificationContextType>({
  notifications: [],
  unreadCount: 0,
  addNotification: () => {},
  markAsRead: () => {},
  markAllAsRead: () => {},
  deleteNotification: () => {},
  clearAll: () => {},
});

// ─── Helpers ────────────────────────────────────────────────────────

const MAX_NOTIFICATIONS = 100;

function truncateText(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : text.substring(0, max) + '...';
}

function storageKey(userId: string) {
  return `notifications_v2_${userId}`;
}

function loadFromStorage(userId: string): AppNotification[] {
  try {
    // Migrar do storage antigo se existir
    const oldKey = `notifications_${userId}`;
    const newKey = storageKey(userId);
    const stored = localStorage.getItem(newKey);
    if (stored) return JSON.parse(stored);

    // Tentar migrar do antigo
    const oldStored = localStorage.getItem(oldKey);
    if (oldStored) {
      const parsed = JSON.parse(oldStored);
      localStorage.setItem(newKey, JSON.stringify(parsed));
      localStorage.removeItem(oldKey);
      return parsed;
    }
  } catch (e) {
    // Storage read error - return empty
  }
  return [];
}

function saveToStorage(userId: string, notifs: AppNotification[]) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(notifs));
  } catch (e) {
    // Storage write error - silently continue
  }
}

function showBrowserNotification(title: string, body: string) {
  if (!('Notification' in window)) return;

  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.ico', tag: 'blue-desk' });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') {
        new Notification(title, { body, icon: '/favicon.ico' });
      }
    });
  }
}

const STATUS_LABELS: Record<string, string> = {
  open: 'Aberta',
  pending: 'Pendente',
  waiting_customer: 'Aguardando cliente',
  closed: 'Encerrada',
};

// ─── Provider ───────────────────────────────────────────────────────

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { authUser } = useAuth();
  const { profile } = useUserProfile();
  const userId = authUser?.id || '';
  const isFullAdmin = profile.isFullAdmin;
  const userUnitIds = useMemo(() => {
    if (isFullAdmin) return [];
    if (profile.unitIds.length > 0) return profile.unitIds;
    if (profile.id_unidade != null) return [profile.id_unidade];
    return [];
  }, [isFullAdmin, profile.unitIds, profile.id_unidade]);

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  // Ref para manter valores atualizados dentro dos callbacks Realtime
  const stateRef = useRef({ userId, userUnitIds, profileId: profile.id });
  useEffect(() => {
    stateRef.current = { userId, userUnitIds, profileId: profile.id };
  }, [userId, userUnitIds, profile.id]);

  // ─── Carregar do storage ──────────────────────────────

  useEffect(() => {
    if (!userId) return;
    const loaded = loadFromStorage(userId);
    setNotifications(loaded);
    setUnreadCount(loaded.filter((n) => !n.read).length);
  }, [userId]);

  // ─── Persistir e atualizar contagem ───────────────────

  const persist = useCallback(
    (updated: AppNotification[]) => {
      if (userId) saveToStorage(userId, updated);
      setUnreadCount(updated.filter((n) => !n.read).length);
    },
    [userId]
  );

  // ─── Mutation methods ─────────────────────────────────

  const addNotification = useCallback(
    (n: AppNotification) => {
      setNotifications((prev) => {
        const updated = [n, ...prev].slice(0, MAX_NOTIFICATIONS);
        persist(updated);
        return updated;
      });
    },
    [persist]
  );

  const markAsRead = useCallback(
    (id: string) => {
      setNotifications((prev) => {
        const updated = prev.map((n) => (n.id === id ? { ...n, read: true } : n));
        persist(updated);
        return updated;
      });
    },
    [persist]
  );

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => {
      const updated = prev.map((n) => ({ ...n, read: true }));
      persist(updated);
      return updated;
    });
  }, [persist]);

  const deleteNotification = useCallback(
    (id: string) => {
      setNotifications((prev) => {
        const updated = prev.filter((n) => n.id !== id);
        persist(updated);
        return updated;
      });
    },
    [persist]
  );

  const clearAll = useCallback(() => {
    setNotifications([]);
    setUnreadCount(0);
    if (userId) localStorage.removeItem(storageKey(userId));
  }, [userId]);

  // ─── Realtime subscriptions ───────────────────────────

  useEffect(() => {
    if (!userId) return;

    // ── 1) Nova mensagem (inbound) ───────────────────────
    const messagesChannel = supabase
      .channel('notif-messages')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: 'direction=eq.inbound',
        },
        async (payload) => {
          const { userId: uid, userUnitIds } = stateRef.current;

          try {
            // Buscar conversa com contato
            const { data: conv } = await supabase
              .from('conversations')
              .select('id, unit_id, assigned_user_id, contact:contacts(display_name, first_name, last_name, phone_number)')
              .eq('id', payload.new.conversation_id)
              .single();

            if (!conv) return;

            // Filtro por unidade: só notifica se conversa é da mesma unidade do usuário
            // (ou se o usuário não tem unidade definida — admin global)
            if (userUnitIds.length > 0 && conv.unit_id != null && !userUnitIds.some(uid => uid === Number(conv.unit_id))) {
              return;
            }

            const contact = conv.contact as any;
            const contactName =
              contact?.display_name ||
              [contact?.first_name, contact?.last_name].filter(Boolean).join(' ') ||
              contact?.phone_number ||
              'Cliente';

            const notif: AppNotification = {
              id: `msg_${payload.new.id}_${Date.now()}`,
              type: 'new_message',
              title: 'Nova mensagem',
              message: `${contactName}: ${truncateText(payload.new.body || payload.new.content, 60)}`,
              read: false,
              created_at: new Date().toISOString(),
              conversation_id: conv.id,
              metadata: { messageId: payload.new.id, contactName },
            };

            addNotification(notif);

            toast.info('Nova mensagem recebida', {
              description: notif.message,
              duration: 5000,
            });

            showBrowserNotification(notif.title, notif.message);
          } catch (err) {
            // Error processing new message notification
          }
        }
      )
      .subscribe();

    // ── 2) Nova conversa ─────────────────────────────────
    const conversationsInsertChannel = supabase
      .channel('notif-conversations-insert')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'conversations',
        },
        async (payload) => {
          const { userUnitIds } = stateRef.current;

          // Filtro por unidade
          if (userUnitIds.length > 0 && payload.new.unit_id != null && !userUnitIds.some(uid => uid === Number(payload.new.unit_id))) {
            return;
          }

          // Buscar nome do contato
          let contactName = payload.new.contact_name || 'Cliente';
          if (payload.new.contact_id) {
            try {
              const { data: contact } = await supabase
                .from('contacts')
                .select('display_name, first_name, last_name, phone_number')
                .eq('id', payload.new.contact_id)
                .single();

              if (contact) {
                contactName =
                  contact.display_name ||
                  [contact.first_name, contact.last_name].filter(Boolean).join(' ') ||
                  contact.phone_number ||
                  contactName;
              }
            } catch {
              /* fallback ao contact_name */
            }
          }

          const notif: AppNotification = {
            id: `conv_${payload.new.id}_${Date.now()}`,
            type: 'new_conversation',
            title: 'Nova conversa',
            message: `Nova conversa iniciada com ${contactName}`,
            read: false,
            created_at: new Date().toISOString(),
            conversation_id: payload.new.id,
            metadata: { contactName, unitId: payload.new.unit_id },
          };

          addNotification(notif);

          toast.success('Nova conversa iniciada', {
            description: notif.message,
            duration: 5000,
          });
        }
      )
      .subscribe();

    // ── 3) Status change + Assignment (UPDATE) ──────────
    const conversationsUpdateChannel = supabase
      .channel('notif-conversations-update')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'conversations',
        },
        async (payload) => {
          const { userId: uid, userUnitIds, profileId } = stateRef.current;
          const oldRow = payload.old as Record<string, any>;
          const newRow = payload.new as Record<string, any>;

          // Filtro por unidade
          if (userUnitIds.length > 0 && newRow.unit_id != null && !userUnitIds.some(uid => uid === Number(newRow.unit_id))) {
            return;
          }

          // Buscar nome do contato para contexto
          let contactName = 'Cliente';
          if (newRow.contact_id) {
            try {
              const { data: contact } = await supabase
                .from('contacts')
                .select('display_name, first_name, last_name')
                .eq('id', newRow.contact_id)
                .single();
              if (contact) {
                contactName =
                  contact.display_name ||
                  [contact.first_name, contact.last_name].filter(Boolean).join(' ') ||
                  contactName;
              }
            } catch {
              /* fallback */
            }
          }

          // ── 3a) Status mudou ────────────────────────────
          if (oldRow.status && newRow.status && oldRow.status !== newRow.status) {
            const oldLabel = STATUS_LABELS[oldRow.status] || oldRow.status;
            const newLabel = STATUS_LABELS[newRow.status] || newRow.status;

            const notif: AppNotification = {
              id: `status_${newRow.id}_${Date.now()}`,
              type: 'status_change',
              title: 'Status alterado',
              message: `${contactName}: ${oldLabel} → ${newLabel}`,
              read: false,
              created_at: new Date().toISOString(),
              conversation_id: newRow.id,
              metadata: {
                oldStatus: oldRow.status,
                newStatus: newRow.status,
                contactName,
              },
            };

            addNotification(notif);

            toast.info('Status de conversa alterado', {
              description: notif.message,
              duration: 4000,
            });
          }

          // ── 3b) Atribuição mudou ────────────────────────
          const oldAssigned = oldRow.assigned_user_id || null;
          const newAssigned = newRow.assigned_user_id || null;

          if (oldAssigned !== newAssigned) {

            // Buscar nome do novo atendente (se houver)
            let assigneeName = '';
            if (newAssigned) {
              try {
                const { data: assignee } = await supabase
                  .from('profiles')
                  .select('nome, sobrenome, email')
                  .eq('id', newAssigned)
                  .single();
                if (assignee) {
                  assigneeName =
                    [assignee.nome, assignee.sobrenome].filter(Boolean).join(' ') ||
                    assignee.email ||
                    'Atendente';
                }
              } catch {
                assigneeName = 'Atendente';
              }
            }

            let message: string;
            let title: string;

            if (!newAssigned) {
              // Desatribuição
              title = 'Conversa desatribuída';
              message = `${contactName}: conversa removida do atendente`;
            } else if (!oldAssigned) {
              // Nova atribuição
              title = 'Conversa atribuída';
              message = `${contactName} → atribuída a ${assigneeName}`;
            } else {
              // Reatribuição
              title = 'Conversa reatribuída';
              message = `${contactName} → transferida para ${assigneeName}`;
            }

            // Se a conversa foi atribuída PARA MIM, destaque especial
            const isForMe = newAssigned === profileId;

            const notif: AppNotification = {
              id: `assign_${newRow.id}_${Date.now()}`,
              type: 'assignment',
              title,
              message,
              read: false,
              created_at: new Date().toISOString(),
              conversation_id: newRow.id,
              metadata: {
                oldAssigned,
                newAssigned,
                assigneeName,
                contactName,
                isForMe,
              },
            };

            addNotification(notif);

            // Toast só quando a conversa é atribuída a MIM. Atribuições de
            // outros atendentes ficam apenas no sino — o toast aparecia o
            // tempo todo e cobria os filtros do CRM.
            if (isForMe) {
              toast.success('Conversa atribuída a você!', {
                description: `${contactName} foi atribuída a você`,
                duration: 6000,
              });
              showBrowserNotification('Conversa atribuída a você', `${contactName} foi atribuída a você`);
            }
          }
        }
      )
      .subscribe();

    return () => {
      messagesChannel.unsubscribe();
      conversationsInsertChannel.unsubscribe();
      conversationsUpdateChannel.unsubscribe();
    };
  }, [userId, userUnitIds, addNotification]);

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        addNotification,
        markAsRead,
        markAllAsRead,
        deleteNotification,
        clearAll,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

// ─── Hook ───────────────────────────────────────────────────────────

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotifications deve ser usado dentro de NotificationProvider');
  }
  return ctx;
}