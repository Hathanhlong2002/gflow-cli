export function validSongPlan() {
  return {
    schemaVersion: 1 as const,
    topic: "Tình yêu",
    language: "vi-VN",
    title: "Chạm vào yêu thương",
    genre: "Vietnamese cinematic pop",
    mood: "warm, hopeful, emotional",
    bpm: 92,
    key: "G major",
    vocalDirection: "Warm expressive alto vocal with clear Vietnamese diction",
    targetDurationSeconds: 180,
    continuity: {
      characters: ["A young Vietnamese couple in their twenties"],
      locations: ["A rain-washed city", "A quiet beach at sunrise"],
      palette: "warm amber and deep blue",
      wardrobe: "simple contemporary neutral clothing",
      prohibitedChanges: ["no logos", "no sudden character redesign"]
    },
    sections: [
      {
        id: "section-01",
        kind: "intro" as const,
        startSeconds: 0,
        endSeconds: 20,
        lyrics: ["Mưa rơi bên hiên vắng"],
        energy: 2
      },
      {
        id: "section-02",
        kind: "verse" as const,
        startSeconds: 20,
        endSeconds: 80,
        lyrics: ["Em đi qua ngày rất xanh", "Mang theo nụ cười trong lành"],
        energy: 3
      },
      {
        id: "section-03",
        kind: "chorus" as const,
        startSeconds: 80,
        endSeconds: 180,
        lyrics: ["Tình yêu đưa ta về gần nhau", "Qua bao tháng năm bạc màu"],
        energy: 5
      }
    ]
  };
}
export function validStoryboard() {
  return {
    schemaVersion: 1 as const,
    durationSeconds: 180,
    entries: [
      {
        id: "visual-001",
        startSeconds: 0,
        endSeconds: 45,
        mode: "flow-video" as const,
        sectionId: "section-01",
        visual: "A couple meets beneath warm streetlights after rain",
        motionPrompt: "Slow cinematic dolly forward",
        importance: 5
      },
      {
        id: "visual-002",
        startSeconds: 45,
        endSeconds: 90,
        mode: "flow-video" as const,
        sectionId: "section-02",
        visual: "Hands almost touching on a quiet train",
        motionPrompt: "Gentle handheld movement",
        importance: 4
      },
      {
        id: "visual-003",
        startSeconds: 90,
        endSeconds: 135,
        mode: "flow-video" as const,
        sectionId: "section-03",
        visual: "The couple runs together along the shoreline",
        motionPrompt: "Wide tracking shot at sunrise",
        importance: 5
      },
      {
        id: "visual-004",
        startSeconds: 135,
        endSeconds: 180,
        mode: "flow-video" as const,
        sectionId: "section-03",
        visual: "Two silhouettes watch the morning light",
        motionPrompt: "Slow crane upward",
        importance: 5
      }
    ]
  };
}

export function validProjectState() {
  return {
    schemaVersion: 1 as const,
    projectId: "tinh-yeu",
    stage: "CREATED" as const,
    topic: "Tình yêu",
    language: "vi-VN",
    targetDurationSeconds: 180,
    models: {
      text: "gemini-3.5-flash",
      image: "gemini-2.5-flash-image",
      music: "lyria-3.5"
    },
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z"
  };
}
