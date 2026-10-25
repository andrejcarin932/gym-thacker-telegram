const STORAGE_KEY = "gym-tracker-workouts";

const form = document.getElementById("exercise-form");
const nameInput = document.getElementById("exercise-name");
const weightInput = document.getElementById("weight");
const repsInput = document.getElementById("reps");
const setsInput = document.getElementById("sets");
const currentWorkoutEl = document.getElementById("current-workout");
const currentVolumeEl = document.getElementById("current-volume");
const saveButton = document.getElementById("save-workout");
const cancelEditButton = document.getElementById("cancel-edit");
const formTitle = document.getElementById("form-title");
const recordsEl = document.getElementById("records");
const historyEl = document.getElementById("history");
const clearAllButton = document.getElementById("clear-all");

let currentExercises = [];
let editingWorkoutId = null;
let programContext = null;
let workouts = loadWorkouts();

function loadWorkouts() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    return [];
  }
}

function saveWorkouts() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workouts));
}

function getVolume(exercise) {
  return exercise.weight * exercise.reps * exercise.sets;
}

function stopEditing() {
  editingWorkoutId = null;
  programContext = null;
  currentExercises = [];
  formTitle.textContent = "Новая тренировка";
  saveButton.textContent = "Сохранить тренировку";
  cancelEditButton.hidden = true;
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function (character) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character];
  });
}

function renderCurrentWorkout() {
  if (currentExercises.length === 0) {
    currentWorkoutEl.className = "empty";
    currentWorkoutEl.textContent = "Пока нет упражнений";
    currentVolumeEl.textContent = "0";
    saveButton.disabled = true;
    return;
  }

  const totalVolume = currentExercises.reduce(function (sum, exercise) {
    return sum + getVolume(exercise);
  }, 0);
  const needsLoad = currentExercises.some(function (exercise) {
    return exercise.needsWeight && !(Number(exercise.weight) > 0);
  });

  currentWorkoutEl.className = "exercise-list";
  currentWorkoutEl.innerHTML = currentExercises.map(function (exercise, index) {
    return (
      '<div class="item workout-exercise"><div class="exercise-main">' +
      '<p><strong>' + escapeHtml(exercise.name) + '</strong></p>' +
      '<div class="exercise-fields">' +
      '<label>Вес, кг<input type="number" min="0" step="0.5" data-index="' + index + '" data-field="weight" value="' + (Number(exercise.weight) || 0) + '" /></label>' +
      '<label>Повторы<input type="number" min="1" step="1" data-index="' + index + '" data-field="reps" value="' + Number(exercise.reps) + '" /></label>' +
      '<label>Подходы<input type="number" min="1" step="1" data-index="' + index + '" data-field="sets" value="' + Number(exercise.sets) + '" /></label>' +
      '<label>RIR<input type="number" min="0" max="5" step="0.5" placeholder="—" data-index="' + index + '" data-field="rir" value="' + (exercise.rir == null ? "" : exercise.rir) + '" /></label>' +
      '</div>' +
      (exercise.needsWeight && !(Number(exercise.weight) > 0) ? '<small class="load-required">Укажите рабочий вес для этого упражнения.</small>' : '') +
      '</div><div class="item-actions"><button class="delete" type="button" data-index="' + index + '">Удалить</button></div></div>'
    );
  }).join("");

  currentVolumeEl.textContent = String(Math.round(totalVolume * 10) / 10);
  saveButton.disabled = needsLoad;
}
function getRecords() {
  const bestByName = {};

  workouts.forEach(function (workout) {
    workout.exercises.forEach(function (exercise) {
      const currentBest = bestByName[exercise.name];
      if (!currentBest || exercise.weight > currentBest.weight) {
        bestByName[exercise.name] = {
          name: exercise.name,
          weight: exercise.weight,
          reps: exercise.reps,
          date: workout.date,
        };
      }
    });
  });

  return Object.values(bestByName).sort(function (a, b) {
    return a.name.localeCompare(b.name, "ru");
  });
}

function renderRecords() {
  const records = getRecords();

  if (records.length === 0) {
    recordsEl.className = "empty";
    recordsEl.textContent = "Рекордов пока нет";
    return;
  }

  recordsEl.className = "records-list";
  recordsEl.innerHTML = records
    .map(function (record) {
      return (
        '<div class="item">' +
        "<div>" +
        "<p><strong>" +
        escapeHtml(record.name) +
        "</strong></p>" +
        "<small>" +
        record.weight +
        " кг × " +
        record.reps +
        " повт. · " +
        formatDate(record.date) +
        "</small>" +
        "</div>" +
        "</div>"
      );
    })
    .join("");
}

function renderHistory() {
  clearAllButton.disabled = workouts.length === 0;

  if (workouts.length === 0) {
    historyEl.className = "empty";
    historyEl.textContent = "История пуста";
    return;
  }

  historyEl.className = "history-list";
  historyEl.innerHTML = workouts
    .map(function (workout) {
      const volume = workout.exercises.reduce(function (sum, exercise) {
        return sum + getVolume(exercise);
      }, 0);
      const names = workout.exercises
        .map(function (exercise) {
          return escapeHtml(exercise.name);
        })
        .join(", ");

      return (
        '<div class="item">' +
        "<div>" +
        "<p><strong>" +
        formatDate(workout.date) +
        "</strong></p>" +
        "<small>" +
        names +
        " · объём " +
        volume +
        " кг" + workout.exercises.filter(function (exercise) { return exercise.rir != null; }).map(function (exercise) { return " · " + escapeHtml(exercise.name) + " RIR " + exercise.rir; }).join("") + "</small>" +
        "</div>" +
        '<div class="item-actions">' +
        '<button class="secondary" type="button" data-action="edit" data-id="' +
        workout.id +
        '">Изменить</button>' +
        '<button class="delete" type="button" data-action="delete" data-id="' +
        workout.id +
        '">Удалить</button>' +
        "</div>" +
        "</div>"
      );
    })
    .join("");
}

function renderAll() {
  renderCurrentWorkout();
  renderRecords();
  renderHistory();
}

form.addEventListener("submit", function (event) {
  event.preventDefault();

  currentExercises.push({
    name: nameInput.value.trim(),
    weight: Number(weightInput.value),
    reps: Number(repsInput.value),
    sets: Number(setsInput.value),
  });

  form.reset();
  nameInput.focus();
  renderCurrentWorkout();
});

currentWorkoutEl.addEventListener("input", function (event) {
  const input = event.target.closest("input[data-index][data-field]");
  if (!input) return;
  const exercise = currentExercises[Number(input.dataset.index)];
  if (!exercise) return;
  const field = input.dataset.field;
  exercise[field] = field === "rir" && input.value === "" ? null : Number(input.value);
  if (field === "weight" && exercise.weight > 0) exercise.needsWeight = false;
  const card = input.closest(".workout-exercise");
  const warning = card && card.querySelector(".load-required");
  if (warning) warning.hidden = !(exercise.needsWeight && !(Number(exercise.weight) > 0));
  const totalVolume = currentExercises.reduce(function (sum, item) { return sum + getVolume(item); }, 0);
  currentVolumeEl.textContent = String(Math.round(totalVolume * 10) / 10);
  const needsLoad = currentExercises.some(function (item) { return item.needsWeight && !(Number(item.weight) > 0); });
  const invalidValues = currentExercises.some(function (item) { return Number(item.reps) < 1 || Number(item.sets) < 1 || Number(item.weight) < 0; });
  saveButton.disabled = needsLoad || invalidValues;
});
currentWorkoutEl.addEventListener("click", function (event) {
  const button = event.target.closest("button[data-index]");
  if (!button) {
    return;
  }

  currentExercises.splice(Number(button.dataset.index), 1);
  renderCurrentWorkout();
});

saveButton.addEventListener("click", function () {
  const completedProgramContext = programContext ? { week: programContext.week, day: programContext.day } : null;
  let cloudWorkout = null;
  if (editingWorkoutId !== null) {
    const originalId = editingWorkoutId;
    workouts = workouts.map(function (workout) {
      if (workout.id !== originalId) return workout;
      cloudWorkout = { id: workout.id, date: workout.date, exercises: currentExercises.map(function (exercise) { return Object.assign({}, exercise); }), programContext: workout.programContext || null };
      return cloudWorkout;
    });
  } else {
    cloudWorkout = {
      id: Date.now(),
      date: new Date().toISOString(),
      exercises: currentExercises.map(function (exercise) { return Object.assign({}, exercise); }),
      programContext: completedProgramContext,
    };
    workouts.unshift(cloudWorkout);
    if (completedProgramContext) applySessionFeedback(completedProgramContext, currentExercises);
  }
  stopEditing();
  saveWorkouts();
  if (cloudWorkout) window.dispatchEvent(new CustomEvent("puls:workout-saved", { detail: cloudWorkout }));
  if (window.showPulsToast) window.showPulsToast("Изменения дневника сохранены");
  renderProgram();
  renderAll();
});
cancelEditButton.addEventListener("click", function () {
  stopEditing();
  renderCurrentWorkout();
});

clearAllButton.addEventListener("click", function () {
  const confirmed = window.confirm(
    "Удалить все тренировки и рекорды? Это нельзя отменить."
  );
  if (!confirmed) {
    return;
  }

  workouts = [];
  stopEditing();
  saveWorkouts();
  window.dispatchEvent(new CustomEvent("puls:workouts-cleared"));
  if (window.showPulsToast) window.showPulsToast("Изменения дневника сохранены");
  renderAll();
});

historyEl.addEventListener("click", function (event) {
  const button = event.target.closest("button[data-id]");
  if (!button) {
    return;
  }

  const workoutId = Number(button.dataset.id);

  if (button.dataset.action === "edit") {
    const workout = workouts.find(function (item) {
      return item.id === workoutId;
    });
    if (!workout) {
      return;
    }

    editingWorkoutId = workout.id;
    programContext = null;
    currentExercises = workout.exercises.map(function (exercise) { return Object.assign({}, exercise); });
    formTitle.textContent = "Редактирование тренировки";
    saveButton.textContent = "Сохранить изменения";
    cancelEditButton.hidden = false;
    renderCurrentWorkout();
    formTitle.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  if (button.dataset.action === "delete") {
    workouts = workouts.filter(function (workout) {
      return workout.id !== workoutId;
    });
    window.dispatchEvent(new CustomEvent("puls:workout-deleted", { detail: workoutId }));

    if (editingWorkoutId === workoutId) {
      stopEditing();
    }

    saveWorkouts();
  if (window.showPulsToast) window.showPulsToast("Изменения дневника сохранены");
    renderAll();
  }
});

const themeSelect = document.getElementById("theme-select");
const savedTheme = localStorage.getItem("gym-tracker-theme") || "red";
document.documentElement.dataset.theme = savedTheme;
themeSelect.value = savedTheme;
themeSelect.addEventListener("change", function () {
  document.documentElement.dataset.theme = themeSelect.value;
  localStorage.setItem("gym-tracker-theme", themeSelect.value);
  if (window.showPulsToast) window.showPulsToast("Тема изменена");
});
const PROGRAM_KEY = "gym-tracker-strength-program";
const programForm = document.getElementById("program-form");
const programOutput = document.getElementById("program-output");
let strengthProgram = loadProgram();
if (strengthProgram) {
  document.getElementById("squat-max").value = strengthProgram.maxes.squat;
  document.getElementById("bench-max").value = strengthProgram.maxes.bench;
  document.getElementById("deadlift-max").value = strengthProgram.maxes.deadlift;
  document.getElementById("training-days").value = String(strengthProgram.daysPerWeek);
  document.getElementById("exercise-count").value = String(strengthProgram.exerciseCount);
  document.getElementById("cycle-weeks").value = String(strengthProgram.cycleWeeks);
  document.getElementById("rounding").value = String(strengthProgram.rounding);
  document.getElementById("intensity-method").value = strengthProgram.method;
  document.getElementById("training-level").value = strengthProgram.trainingLevel || "regular";
}

function loadProgram() {
  try {
    const program = JSON.parse(localStorage.getItem(PROGRAM_KEY));
    return program && program.schemaVersion === 3 && program.exerciseCount && program.maxes ? program : null;
  } catch (error) { return null; }
}
function roundTo(value, step) { return Math.round(value / step) * step; }

function getLatestExerciseLog(name) {
  const normalizedName = String(name).trim().toLocaleLowerCase("ru");
  for (let i = 0; i < workouts.length; i += 1) {
    const found = workouts[i].exercises.find(function (exercise) {
      return String(exercise.name).trim().toLocaleLowerCase("ru") === normalizedName;
    });
    if (found && Number(found.weight) > 0) return found;
  }
  return null;
}

function suggestManualLoad(name, rounding) {
  const previous = getLatestExerciseLog(name);
  if (!previous) return null;
  let weight = Number(previous.weight);
  if (previous.rir != null && previous.rir !== "" && Number.isFinite(Number(previous.rir))) {
    if (Number(previous.rir) >= 4) weight += rounding;
    else if (Number(previous.rir) <= 1) weight *= 0.95;
  }
  return roundTo(weight, rounding);
}

function targetRirForWeek(weekNumber) {
  return Math.max(1, 4 - Math.floor((weekNumber - 1) / 4));
}

function makeProgram(maxes, daysPerWeek, weeks, rounding, method, exerciseCount, trainingLevel) {
  const weeklyPercent = [60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82, 84, 86, 89, 92];
  const mainReps = [8, 7, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 2, 1, 1];
  const variationReps = [8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2];
  const accessoryReps = [12, 12, 12, 10, 10, 10, 8, 8, 8, 8, 6, 6, 6, 6, 6, 6];
  const mainSets = [4, 4, 4, 3, 4, 4, 4, 3, 4, 3, 3, 2, 3, 2, 2, 1];
  const variationSets = [3, 3, 3, 2, 3, 3, 3, 2, 3, 3, 2, 1, 2, 2, 1, 1];
  const competitionLifts = ["Присед со штангой", "Жим лёжа", "Становая тяга"];
  const templates = daysPerWeek === 3 ? [
    [
      { name: "Присед со штангой", key: "squat", sets: 4, reps: 5, base: 0.65, main: true },
      { name: "Жим лёжа", key: "bench", sets: 4, reps: 5, base: 0.65, main: true },
      { name: "Румынская тяга со штангой", key: "deadlift", sets: 3, reps: 8, base: 0.38 },
      { name: "Тяга штанги в наклоне", key: "bench", sets: 4, reps: 8, base: 0.42 },
      { name: "Болгарские выпады с гантелями", key: "squat", sets: 3, reps: 8, base: 0.18 },
      { name: "Подъёмы гантелей в стороны", key: "bench", sets: 3, reps: 12, base: 0.12 },
    ],
    [
      { name: "Становая тяга", key: "deadlift", sets: 3, reps: 5, base: 0.65, main: true },
      { name: "Жим лёжа с паузой", key: "bench", sets: 4, reps: 4, base: 0.62, main: true },
      { name: "Фронтальный присед со штангой", key: "squat", sets: 3, reps: 6, base: 0.42 },
      { name: "Жим гантелей на наклонной скамье", key: "bench", sets: 3, reps: 8, base: 0.30 },
      { name: "Тяга гантели одной рукой", key: "bench", sets: 3, reps: 10, base: 0.25 },
      { name: "Сгибание рук с гантелями", key: "bench", sets: 3, reps: 10, base: 0.16 },
    ],
    [
      { name: "Присед с паузой", key: "squat", sets: 3, reps: 4, base: 0.60, main: true },
      { name: "Жим лёжа узким хватом", key: "bench", sets: 4, reps: 6, base: 0.60, main: true },
      { name: "Становая тяга с лёгким весом", key: "deadlift", sets: 2, reps: 5, base: 0.55, main: true },
      { name: "Ягодичный мост со штангой", key: "deadlift", sets: 3, reps: 8, base: 0.40 },
      { name: "Разведения гантелей лёжа", key: "bench", sets: 3, reps: 10, base: 0.18 },
      { name: "Подъёмы на носки с гантелями", key: "deadlift", sets: 3, reps: 12, base: 0.18 },
    ],
  ] : [
    [
      { name: "Присед со штангой", key: "squat", sets: 4, reps: 5, base: 0.65, main: true },
      { name: "Жим лёжа", key: "bench", sets: 4, reps: 5, base: 0.65, main: true },
      { name: "Румынская тяга со штангой", key: "deadlift", sets: 3, reps: 8, base: 0.38 },
      { name: "Тяга штанги в наклоне", key: "bench", sets: 4, reps: 8, base: 0.42 },
      { name: "Болгарские выпады с гантелями", key: "squat", sets: 3, reps: 8, base: 0.18 },
      { name: "Подъёмы гантелей в стороны", key: "bench", sets: 3, reps: 12, base: 0.12 },
    ],
    [
      { name: "Становая тяга", key: "deadlift", sets: 4, reps: 4, base: 0.65, main: true },
      { name: "Жим штанги стоя", key: "bench", sets: 3, reps: 6, base: 0.38 },
      { name: "Фронтальный присед со штангой", key: "squat", sets: 3, reps: 6, base: 0.42 },
      { name: "Тяга гантели одной рукой", key: "bench", sets: 3, reps: 10, base: 0.25 },
      { name: "Ягодичный мост со штангой", key: "deadlift", sets: 3, reps: 8, base: 0.40 },
      { name: "Сгибание рук с гантелями", key: "bench", sets: 3, reps: 10, base: 0.16 },
    ],
    [
      { name: "Жим лёжа с паузой", key: "bench", sets: 4, reps: 4, base: 0.68, main: true },
      { name: "Присед с паузой", key: "squat", sets: 3, reps: 5, base: 0.60, main: true },
      { name: "Жим гантелей на наклонной скамье", key: "bench", sets: 3, reps: 8, base: 0.30 },
      { name: "Тяга штанги в наклоне", key: "bench", sets: 4, reps: 8, base: 0.42 },
      { name: "Болгарские выпады с гантелями", key: "squat", sets: 3, reps: 8, base: 0.18 },
      { name: "Разведения гантелей лёжа", key: "bench", sets: 3, reps: 10, base: 0.18 },
    ],
    [
      { name: "Становая тяга с лёгким весом", key: "deadlift", sets: 3, reps: 5, base: 0.60, main: true },
      { name: "Жим лёжа узким хватом", key: "bench", sets: 3, reps: 6, base: 0.60, main: true },
      { name: "Румынская тяга со штангой", key: "deadlift", sets: 3, reps: 8, base: 0.38 },
      { name: "Жим гантелей сидя", key: "bench", sets: 3, reps: 8, base: 0.25 },
      { name: "Тяга гантелей к поясу с упором", key: "bench", sets: 3, reps: 10, base: 0.30 },
      { name: "Подъёмы на носки с гантелями", key: "deadlift", sets: 3, reps: 12, base: 0.18 },
    ],
  ];
  const stages = ["Набор объёма", "Развитие силы", "Интенсификация", "Пик формы"];
  return {
    schemaVersion: 3,
    method: method,
    exerciseCount: exerciseCount,
    maxes: maxes,
    daysPerWeek: daysPerWeek,
    cycleWeeks: weeks,
    trainingLevel: trainingLevel,
    rounding: rounding,
    weeks: Array.from({ length: 16 }, function (_, weekIndex) {
      const targetPercent = weeklyPercent[weekIndex];
      const stageIndex = Math.min(3, Math.floor(weekIndex / 4));
      const recovery = [3, 7, 11].indexOf(weekIndex) !== -1;
      return {
        number: weekIndex + 1,
        stage: stages[stageIndex],
        percent: targetPercent,
        recovery: recovery,
        days: templates.map(function (day, dayIndex) {
          return {
            number: dayIndex + 1,
            exercises: day.slice(0, exerciseCount).map(function (item) {
              const isCompetitionLift = competitionLifts.indexOf(item.name) !== -1;
              const isPercentageLoad = isCompetitionLift || Boolean(item.main);
              const percent = isPercentageLoad
                ? (isCompetitionLift ? targetPercent / 100 : item.base + (targetPercent / 100 - 0.60) * 0.25)
                : null;
              const previousAccessoryWeight = isPercentageLoad ? null : suggestManualLoad(item.name, rounding);
              const reps = isCompetitionLift
                ? mainReps[weekIndex]
                : item.main
                  ? variationReps[weekIndex]
                  : Math.min(item.reps, accessoryReps[weekIndex]);
              let sets = isCompetitionLift
                ? mainSets[weekIndex]
                : item.main
                  ? variationSets[weekIndex]
                  : Math.max(1, item.sets - Math.floor(weekIndex / 5));
              if (recovery && !isCompetitionLift) sets = Math.max(1, sets - 1);
              if (trainingLevel === "beginner") sets = Math.max(1, sets - 1);
              return {
                name: item.name,
                main: isCompetitionLift,
                loadMode: isPercentageLoad ? "percentage" : "rir",
                liftKey: item.key,
                targetRir: targetRirForWeek(weekIndex + 1),
                sets: sets,
                reps: reps,
                percent: percent,
                weight: isPercentageLoad ? roundTo(maxes[item.key] * percent, rounding) : previousAccessoryWeight,
              };
            }),
          };
        }),
      };
    }),
  };
}
function renderProgram() {
  if (!strengthProgram) {
    programOutput.className = "program-output empty";
    programOutput.textContent = "Укажи максимумы — и здесь появится твой план.";
    return;
  }
  const openWeeks = new Set(Array.from(programOutput.querySelectorAll(".week-card[open]"), function (card) { return Number(card.dataset.week); }));
  if (openWeeks.size === 0) openWeeks.add(1);
  programOutput.className = "program-output";
  programOutput.innerHTML = strengthProgram.weeks.map(function (week) {
    const days = week.days.map(function (day) {
      const rows = day.exercises.map(function (exercise) {
        const prescription = exercise.loadMode === "percentage"
          ? exercise.sets + " × " + exercise.reps + " · " + Math.round(exercise.percent * 100) + "% · " + exercise.weight + " кг" + (strengthProgram.method === "rir" ? " · RIR " + exercise.targetRir : "")
          : exercise.sets + " × " + exercise.reps + " · вес по RIR 2–3" + (exercise.weight ? " · старт " + exercise.weight + " кг по журналу" : " · укажи вес в журнале");
        return "<li><strong>" + escapeHtml(exercise.name) + "</strong><span>" + prescription + "</span></li>";
      }).join("");
      return "<div class=\"day-card\"><h4>День " + day.number + "</h4><ul>" + rows + "</ul><button class=\"secondary add-program-day\" type=\"button\" data-week=\"" + week.number + "\" data-day=\"" + day.number + "\">Добавить день в журнал</button></div>";
    }).join("");
    const opened = openWeeks.has(week.number) ? " open" : "";
    const recovery = week.recovery ? " · облегчённый объём" : "";
    return "<details class=\"week-card\" data-week=\"" + week.number + "\"" + opened + "><summary><span>Неделя " + week.number + "</span><small>" + week.stage + " · " + week.percent + "%" + recovery + "</small></summary><div class=\"program-days\">" + days + "</div></details>";
  }).join("");
}
programForm.addEventListener("submit", function (event) {
  event.preventDefault();
  const maxes = {
    squat: Number(document.getElementById("squat-max").value),
    bench: Number(document.getElementById("bench-max").value),
    deadlift: Number(document.getElementById("deadlift-max").value),
  };
  document.getElementById("program-feedback").textContent = "";
  strengthProgram = makeProgram(maxes, Number(document.getElementById("training-days").value), Number(document.getElementById("cycle-weeks").value), Number(document.getElementById("rounding").value), document.getElementById("intensity-method").value, Number(document.getElementById("exercise-count").value), document.getElementById("training-level").value);
  localStorage.setItem(PROGRAM_KEY, JSON.stringify(strengthProgram));
  window.dispatchEvent(new CustomEvent("puls:program-changed", { detail: strengthProgram }));
  if (window.showPulsToast) window.showPulsToast("Программа сохранена");
  renderProgram();
});

function applySessionFeedback(context, completedExercises) {
  if (!strengthProgram || !context) return;
  let changed = false;
  const referenceRir = targetRirForWeek(context.week);
  const rounding = strengthProgram.rounding || 2.5;
  completedExercises.forEach(function (completed) {
    if (!completed.name) return;
    const currentWeek = strengthProgram.weeks.find(function (week) { return week.number === context.week; });
    const currentDay = currentWeek && currentWeek.days.find(function (day) { return day.number === context.day; });
    const planned = currentDay && currentDay.exercises.find(function (exercise) { return exercise.name === completed.name; });
    if (!planned) return;
    const future = [];
    strengthProgram.weeks.forEach(function (week) {
      if (week.number <= context.week) return;
      const day = week.days.find(function (item) { return item.number === context.day; });
      const exercise = day && day.exercises.find(function (item) { return item.name === completed.name; });
      if (exercise) future.push(exercise);
    });
    if (!future.length) return;
    const missed = Number(completed.reps) < planned.reps || Number(completed.sets) < planned.sets;
    const actualRir = completed.rir == null ? null : Number(completed.rir);
    if (planned.loadMode === "percentage") {
      const adjustment = missed || actualRir != null && actualRir <= Math.max(0, referenceRir - 2)
        ? -0.02
        : actualRir != null && actualRir >= referenceRir + 1 ? 0.01 : 0;
      if (!adjustment) return;
      future.forEach(function (exercise) {
        exercise.percent = Math.max(0.50, Math.min(0.95, exercise.percent + adjustment));
        exercise.weight = roundTo(strengthProgram.maxes[exercise.liftKey] * exercise.percent, rounding);
      });
      changed = true;
      return;
    }
    let nextWeight = Number(completed.weight);
    if (!(nextWeight > 0)) return;
    if (missed || actualRir != null && actualRir <= 1) nextWeight = roundTo(nextWeight * 0.95, rounding);
    else if (actualRir != null && actualRir >= 4) nextWeight = roundTo(nextWeight + rounding, rounding);
    future.forEach(function (exercise) { exercise.weight = nextWeight; });
    changed = true;
  });
  if (changed) {
    localStorage.setItem(PROGRAM_KEY, JSON.stringify(strengthProgram));
    document.getElementById("program-feedback").textContent = "Будущие недели скорректированы по RIR и выполненным повторениям.";
  } else if (completedExercises.some(function (exercise) { return exercise.rir != null; })) {
    document.getElementById("program-feedback").textContent = "Рабочая нагрузка оставлена без изменений: результат в заданном диапазоне.";
  }
}
programOutput.addEventListener("click", function (event) {
  const button = event.target.closest(".add-program-day");
  if (!button || !strengthProgram) return;
  const weekNumber = Number(button.dataset.week);
  const dayNumber = Number(button.dataset.day);
  const week = strengthProgram.weeks.find(function (item) { return item.number === weekNumber; });
  const day = week && week.days.find(function (item) { return item.number === dayNumber; });
  if (!day) return;
  stopEditing();
  programContext = { week: weekNumber, day: dayNumber };
  currentExercises = day.exercises.map(function (exercise) {
    const weight = Number(exercise.weight) || 0;
    return {
      name: exercise.name,
      weight: weight,
      reps: exercise.reps,
      sets: exercise.sets,
      rir: null,
      liftKey: exercise.liftKey,
      loadMode: exercise.loadMode,
      targetRir: exercise.targetRir,
      needsWeight: exercise.loadMode === "rir" && weight <= 0,
    };
  });
  renderCurrentWorkout();
  formTitle.textContent = "Тренировка из программы · неделя " + weekNumber + ", день " + dayNumber;
  document.getElementById("exercise-form").scrollIntoView({ behavior: "smooth", block: "start" });
});
const exportBackupButton = document.getElementById("export-backup");
const importBackupButton = document.getElementById("import-backup-button");
const importBackupFile = document.getElementById("import-backup-file");

exportBackupButton.addEventListener("click", function () {
  const backup = {
    format: "puls-sily-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    workouts: workouts,
    program: strengthProgram,
    theme: document.documentElement.dataset.theme || "red",
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "puls-sily-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  link.click();
  URL.revokeObjectURL(url);
  if (window.showPulsToast) window.showPulsToast("Резервная копия скачана");
});

importBackupButton.addEventListener("click", function () { importBackupFile.click(); });
importBackupFile.addEventListener("change", function () {
  const file = importBackupFile.files && importBackupFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const backup = JSON.parse(String(reader.result));
      if (backup.format !== "puls-sily-backup" || !Array.isArray(backup.workouts) || !backup.workouts.every(function (workout) { return workout && Array.isArray(workout.exercises); })) {
        throw new Error("Файл не похож на резервную копию Пульса силы.");
      }
      if (!window.confirm("Заменить текущую историю тренировок данными из резервной копии?")) return;
      workouts = backup.workouts;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(workouts));
      window.dispatchEvent(new CustomEvent("puls:workouts-replaced", { detail: workouts }));
  if (window.showPulsToast) window.showPulsToast("Изменения дневника сохранены");
      if (backup.program && backup.program.schemaVersion === 3) {
        strengthProgram = backup.program;
        localStorage.setItem(PROGRAM_KEY, JSON.stringify(strengthProgram));
      }
      if (["red", "blue", "purple", "light"].indexOf(backup.theme) !== -1) {
        document.documentElement.dataset.theme = backup.theme;
        themeSelect.value = backup.theme;
        localStorage.setItem("gym-tracker-theme", backup.theme);
        window.dispatchEvent(new CustomEvent("puls:theme-changed", { detail: backup.theme }));
      }
      renderProgram();
      renderAll();
      if (window.showPulsToast) window.showPulsToast("Резервная копия восстановлена");
    } catch (error) {
      if (window.showPulsToast) window.showPulsToast(error.message || "Не удалось прочитать резервную копию.", "error");
    } finally {
      importBackupFile.value = "";
    }
  };
  reader.readAsText(file);
});
renderProgram();
renderAll();
window.PulsWorkoutApp = {
  getWorkouts: function () { return workouts.slice(); },
  getProgram: function () { return strengthProgram; },
  setWorkouts: function (items) { workouts = Array.isArray(items) ? items : []; localStorage.setItem(STORAGE_KEY, JSON.stringify(workouts)); stopEditing(); renderAll(); },
  setProgram: function (program) { strengthProgram = program && program.schemaVersion === 3 ? program : null; if (strengthProgram) { localStorage.setItem(PROGRAM_KEY, JSON.stringify(strengthProgram)); document.getElementById("squat-max").value = strengthProgram.maxes.squat; document.getElementById("bench-max").value = strengthProgram.maxes.bench; document.getElementById("deadlift-max").value = strengthProgram.maxes.deadlift; document.getElementById("training-days").value = String(strengthProgram.daysPerWeek); document.getElementById("exercise-count").value = String(strengthProgram.exerciseCount); document.getElementById("cycle-weeks").value = String(strengthProgram.cycleWeeks); document.getElementById("rounding").value = String(strengthProgram.rounding); document.getElementById("intensity-method").value = strengthProgram.method; document.getElementById("training-level").value = strengthProgram.trainingLevel || "regular"; } else { localStorage.removeItem(PROGRAM_KEY); } renderProgram(); },
  refresh: function () { renderAll(); renderProgram(); }
};
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./service-worker.js").catch(function () {});
}
























