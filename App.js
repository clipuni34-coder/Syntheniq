import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet, SafeAreaView, StatusBar } from 'react-native';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import WebSocket from 'ws';

export default function App() {
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [gameState, setGameState] = useState(null);
  const [events, setEvents] = useState([]);
  const [monitoring, setMonitoring] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  const WS_URL = process.env.WS_URL || 'ws://localhost:3000';

  const connectWebSocket = () => {
    setConnectionStatus('connecting');
    
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.on('open', () => {
      console.log('Connected to server');
      setConnectionStatus('connected');
      clearTimeout(reconnectTimeoutRef.current);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleWebSocketMessage(msg);
      } catch (e) {
        console.error('Error parsing message:', e);
      }
    });

    ws.on('close', () => {
      console.log('Disconnected from server');
      setConnectionStatus('disconnected');
      
      // Auto-reconnect
      reconnectTimeoutRef.current = setTimeout(() => {
        connectWebSocket();
      }, 3000);
    });

    ws.on('error', (err) => {
      console.error('WebSocket error:', err.message);
    });
  };

  const handleWebSocketMessage = (msg) => {
    switch (msg.type) {
      case 'GAME_STATE_UPDATE':
      case 'GAME_STATE':
        setGameState(msg.data);
        break;
      case 'RACE_WINDOW_DETECTED':
        addEvent({
          type: 'race',
          title: 'Race Window Detected',
          description: `Result ${msg.data.result} (${msg.data.color}) with ${Math.round(msg.data.msRemaining / 1000)}s remaining`,
          timestamp: new Date().toISOString(),
          data: msg.data
        });
        break;
      case 'BET_RESULT':
        addEvent({
          type: 'bet',
          title: msg.data.success ? 'Bet Placed' : 'Bet Failed',
          description: msg.data.msg || msg.data.error || '',
          timestamp: new Date().toISOString(),
          data: msg.data
        });
        break;
      case 'MONITORING_STARTED':
        setMonitoring(true);
        break;
      case 'MONITORING_STOPPED':
        setMonitoring(false);
        break;
    }
  };

  const addEvent = (event) => {
    setEvents(prev => [event, ...prev.slice(0, 49)]);
  };

  const toggleMonitoring = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      if (monitoring) {
        wsRef.current.send(JSON.stringify({ type: 'STOP_MONITORING' }));
        setMonitoring(false);
      } else {
        wsRef.current.send(JSON.stringify({ type: 'START_MONITORING' }));
        setMonitoring(true);
      }
    }
  };

  const placeBet = (color) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'PLACE_BET',
        data: {
          SelectType: color,
          Amount: 1,
          BetCount: 1
        }
      }));
    }
  };

  useEffect(() => {
    connectWebSocket();
    
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      clearTimeout(reconnectTimeoutRef.current);
    };
  }, []);

  const renderEvent = ({ item }) => (
    <View style={[
      styles.eventCard,
      item.type === 'race' ? styles.raceEvent : styles.betEvent
    ]}>
      <Text style={styles.eventTitle}>{item.title}</Text>
      <Text style={styles.eventDesc}>{item.description}</Text>
      <Text style={styles.eventTime}>
        {new Date(item.timestamp).toLocaleTimeString()}
      </Text>
    </View>
  );

  const getColorStats = () => {
    const red = events.filter(e => e.data?.color === 'Red').length;
    const green = events.filter(e => e.data?.color === 'Green').length;
    const violet = events.filter(e => e.data?.color === 'Violet').length;
    return { red, green, violet };
  };

  const stats = getColorStats();

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      
      <View style={styles.header}>
        <Text style={styles.title}>WinGo Racer</Text>
        <View style={styles.connectionBadge}>
          <View style={[
            styles.connectionDot,
            connectionStatus === 'connected' ? styles.connected : 
            connectionStatus === 'connecting' ? styles.connecting : styles.disconnected
          ]} />
          <Text style={styles.connectionText}>
            {connectionStatus.toUpperCase()}
          </Text>
        </View>
      </View>

      <View style={styles.gameInfo}>
        {gameState ? (
          <>
            <Text style={styles.infoText}>Current: {gameState.currentIssue}</Text>
            <Text style={styles.infoText}>Next: {gameState.nextIssue}</Text>
            <Text style={styles.infoText}>
              Time to Close: {gameState.timeToClose ? `${Math.round(gameState.timeToClose / 1000)}s` : '—'}
            </Text>
            {gameState.raceWindow?.active && (
              <View style={styles.raceAlert}>
                <Text style={styles.raceAlertText}>
                  ⚡ RACE WINDOW ACTIVE! {gameState.raceWindow.color} ({gameState.raceWindow.result})
                </Text>
                <Text style={styles.raceAlertSub}>
                  {Math.round(gameState.raceWindow.msRemaining / 1000)}s remaining
                </Text>
              </View>
            )}
          </>
        ) : (
          <Text style={styles.infoText}>Connecting...</Text>
        )}
      </View>

      <View style={styles.statsContainer}>
        <View style={[styles.statBox, { backgroundColor: '#ff5252' }]}>
          <Text style={styles.statLabel}>RED</Text>
          <Text style={styles.statValue}>{stats.red}</Text>
        </View>
        <View style={[styles.statBox, { backgroundColor: '#4caf50' }]}>
          <Text style={styles.statLabel}>GREEN</Text>
          <Text style={styles.statValue}>{stats.green}</Text>
        </View>
        <View style={[styles.statBox, { backgroundColor: '#9c27b0' }]}>
          <Text style={styles.statLabel}>VIOLET</Text>
          <Text style={styles.statValue}>{stats.violet}</Text>
        </View>
      </View>

      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.monitorButton, monitoring && styles.monitorButtonActive]}
          onPress={toggleMonitoring}
        >
          <Text style={styles.monitorButtonText}>
            {monitoring ? 'Stop Monitoring' : 'Start Monitoring'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.betButtons}>
        <Text style={styles.betLabel}>Quick Bet:</Text>
        <View style={styles.betRow}>
          <TouchableOpacity
            style={[styles.betButton, { backgroundColor: '#ff5252' }]}
            onPress={() => placeBet('Red')}
          >
            <Text style={styles.betButtonText}>RED</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.betButton, { backgroundColor: '#4caf50' }]}
            onPress={() => placeBet('Green')}
          >
            <Text style={styles.betButtonText}>GREEN</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.betButton, { backgroundColor: '#9c27b0' }]}
            onPress={() => placeBet('Violet')}
          >
            <Text style={styles.betButtonText}>VIOLET</Text>
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={events}
        renderItem={renderEvent}
        keyExtractor={(item, index) => `${item.timestamp}-${index}`}
        style={styles.eventList}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No events yet. Start monitoring to see results.</Text>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f23',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a4a',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#00d4ff',
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  connectionDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  connected: {
    backgroundColor: '#4caf50',
  },
  connecting: {
    backgroundColor: '#ff9800',
  },
  disconnected: {
    backgroundColor: '#f44336',
  },
  connectionText: {
    color: '#fff',
    fontSize: 12,
  },
  gameInfo: {
    backgroundColor: '#1a1a2e',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    gap: 8,
  },
  infoText: {
    color: '#aaa',
    fontSize: 16,
  },
  raceAlert: {
    backgroundColor: '#ff5252',
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
  },
  raceAlertText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  raceAlertSub: {
    color: '#fff',
    fontSize: 14,
    opacity: 0.9,
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginBottom: 16,
  },
  statBox: {
    width: 80,
    height: 80,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  statValue: {
    color: '#fff',
    fontSize: 24,
    fontWeight: 'bold',
  },
  controls: {
    alignItems: 'center',
    marginBottom: 16,
  },
  monitorButton: {
    backgroundColor: '#2196f3',
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 24,
  },
  monitorButtonActive: {
    backgroundColor: '#ff5252',
  },
  monitorButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  betButtons: {
    marginHorizontal: 16,
    marginBottom: 16,
  },
  betLabel: {
    color: '#888',
    fontSize: 14,
    marginBottom: 8,
  },
  betRow: {
    flexDirection: 'row',
    gap: 12,
  },
  betButton: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  betButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  eventList: {
    flex: 1,
    paddingHorizontal: 16,
  },
  eventCard: {
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderLeftWidth: 4,
  },
  raceEvent: {
    borderLeftColor: '#ff5252',
  },
  betEvent: {
    borderLeftColor: '#4caf50',
  },
  eventTitle: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  eventDesc: {
    color: '#aaa',
    fontSize: 12,
    marginTop: 2,
  },
  eventTime: {
    color: '#666',
    fontSize: 10,
    marginTop: 4,
    textAlign: 'right',
  },
  emptyText: {
    textAlign: 'center',
    color: '#555',
    marginTop: 32,
    fontSize: 16,
  },
});
