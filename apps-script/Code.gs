// Stackd Ops — Google Apps Script webhook
// Deployed as a Web App (Execute as: Me, Access: Anyone with the link + token)
// Paste the deployment URL into Stackd Ops → Settings → Google Sheets

var SYNC_TOKEN = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN') || '';
var REQUIREMENTS_TRACKER_ID = '1q05sSoCMmiqaNNixDWVk2_aJPwEqx37vDbOPNh2gqGw';
var PROJECT_TRACKER_ID      = '1gC6d7ClOFpaocK_lNI685x5yMK5_UHiMgriFlF_UrLg';

// Maps Stackd entity keys to sheet tab names
var SHEET_NAMES = {
  sup:       'Suppliers',
  li:        'Line Items',
  inv:       'Invoices',
  po:        'Purchase Orders',
  sh:        'Shipments',
  qt:        'Quotes',
  payments:  'Payments',
  cn:        'Credit Notes',
  inv_lines: 'inv_lines'
};

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    if (SYNC_TOKEN && payload._token !== SYNC_TOKEN) {
      return jsonResp({ status: 'error', message: 'Unauthorized' });
    }

    var action = payload.action;

    if (action === 'upsert')                      return jsonResp(handleUpsert(payload));
    if (action === 'bulk_upsert')                 return jsonResp(handleBulkUpsert(payload));
    if (action === 'delete')                      return jsonResp(handleDelete(payload));
    if (action === 'get_all')                     return jsonResp(handleGetAll(payload));
    if (action === 'import_from_master')          return jsonResp(handleImportFromMaster(payload));
    if (action === 'update_requirements_tracker') return jsonResp(handleUpdateRequirementsTracker(payload));
    if (action === 'update_project_tracker')      return jsonResp(handleUpdateProjectTracker(payload));

    return jsonResp({ status: 'error', message: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResp({ status: 'error', message: err.message });
  }
}

// ── upsert ──────────────────────────────────────────────────────
function handleUpsert(payload) {
  var sheet = getEntitySheet(payload.entity);
  if (!sheet) return { status: 'error', message: 'Unknown entity: ' + payload.entity };
  var rec = payload.record;
  if (!rec || !rec.id) return { status: 'error', message: 'record.id is required' };

  var headers = getHeaders(sheet);
  var idCol   = headers.indexOf('id');
  if (idCol === -1) {
    writeHeaders(sheet, rec);
    appendRow(sheet, getHeaders(sheet), rec);
    return { status: 'ok' };
  }

  var data    = sheet.getDataRange().getValues();
  var rowIdx  = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(rec.id)) { rowIdx = i; break; }
  }

  if (rowIdx === -1) {
    appendRow(sheet, headers, rec);
  } else {
    updateRow(sheet, rowIdx + 1, headers, rec);
  }
  return { status: 'ok' };
}

// ── bulk_upsert ─────────────────────────────────────────────────
function handleBulkUpsert(payload) {
  var sheet = getEntitySheet(payload.entity);
  if (!sheet) return { status: 'error', message: 'Unknown entity: ' + payload.entity };
  var records = payload.records;
  if (!Array.isArray(records)) return { status: 'error', message: 'records must be an array' };

  if (records.length === 0) return { status: 'ok', written: 0 };

  var headers = Object.keys(records[0]);
  sheet.clearContents();
  sheet.appendRow(headers);

  var rows = records.map(function(rec) {
    return headers.map(function(h) {
      var v = rec[h];
      return (v !== null && v !== undefined && typeof v === 'object') ? JSON.stringify(v) : (v !== undefined ? v : '');
    });
  });
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  return { status: 'ok', written: records.length };
}

// ── delete ──────────────────────────────────────────────────────
function handleDelete(payload) {
  var sheet = getEntitySheet(payload.entity);
  if (!sheet) return { status: 'error', message: 'Unknown entity: ' + payload.entity };
  var headers = getHeaders(sheet);
  var idCol   = headers.indexOf('id');
  if (idCol === -1) return { status: 'ok' };

  var data = sheet.getDataRange().getValues();
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][idCol]) === String(payload.id)) {
      sheet.deleteRow(i + 1);
      return { status: 'ok' };
    }
  }
  return { status: 'ok' };
}

// ── get_all ─────────────────────────────────────────────────────
function handleGetAll(payload) {
  var sheet = getEntitySheet(payload.entity);
  if (!sheet) return { status: 'error', message: 'Unknown entity: ' + payload.entity };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { status: 'ok', records: [] };

  var headers = data[0].map(String);
  var records = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rec = {};
    for (var j = 0; j < headers.length; j++) {
      var v = row[j];
      if (typeof v === 'string' && (v.charAt(0) === '[' || v.charAt(0) === '{')) {
        try { v = JSON.parse(v); } catch (e) {}
      }
      rec[headers[j]] = v;
    }
    records.push(rec);
  }
  return { status: 'ok', records: records };
}

// ── import_from_master ──────────────────────────────────────────
function handleImportFromMaster(payload) {
  return handleGetAll(payload);
}

// ── update_requirements_tracker ─────────────────────────────────
// Payload: { updates: [{ id: 41, field: "Status", value: "Done" }, ...] }
function handleUpdateRequirementsTracker(payload) {
  return handleTrackerUpdate(payload, REQUIREMENTS_TRACKER_ID, 'Requirements Tracker');
}

// ── update_project_tracker ─────────────────────────────────────
// Payload: { updates: [{ id: 35, field: "Status", value: "Done" }, ...] }
function handleUpdateProjectTracker(payload) {
  return handleTrackerUpdate(payload, PROJECT_TRACKER_ID, 'Project Tracker');
}

// ── handleTrackerUpdate (shared) ──────────────────────────────
function handleTrackerUpdate(payload, sheetId, sheetName) {
  var updates = payload.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return { success: false, error: 'updates array is required and must be non-empty' };
  }

  var ss;
  try {
    ss = SpreadsheetApp.openById(sheetId);
  } catch (err) {
    return { success: false, error: 'Could not open ' + sheetName + ': ' + err.message };
  }

  var sheet = ss.getSheetByName(sheetName) || ss.getSheets()[0];
  if (!sheet) return { success: false, error: 'No sheets found in ' + sheetName + ' spreadsheet' };

  var data = sheet.getDataRange().getValues();
  if (data.length < 1) return { success: false, error: sheetName + ' sheet is empty' };

  var headers  = data[0].map(String);
  var idColIdx = headers.indexOf('ID');
  if (idColIdx === -1) idColIdx = 0;

  var rowMap = {};
  for (var i = 1; i < data.length; i++) {
    var rowId = data[i][idColIdx];
    if (rowId !== '' && rowId !== null && rowId !== undefined) {
      rowMap[String(rowId)] = i + 1;
    }
  }

  var updated = [];
  var errors  = [];

  updates.forEach(function(u) {
    var rowNum = rowMap[String(u.id)];
    if (!rowNum) {
      errors.push({ id: u.id, field: u.field, error: 'Row ID ' + u.id + ' not found' });
      return;
    }
    var colIdx = headers.indexOf(u.field);
    if (colIdx === -1) {
      errors.push({ id: u.id, field: u.field, error: 'Column "' + u.field + '" not found' });
      return;
    }
    sheet.getRange(rowNum, colIdx + 1).setValue(u.value);
    updated.push({ id: u.id, field: u.field });
  });

  if (errors.length && !updated.length) {
    return { success: false, error: errors[0].error, errors: errors };
  }

  var result = { success: true, updated: updated };
  if (errors.length) result.errors = errors;
  return result;
}

// ── helpers ──────────────────────────────────────────────────────

function getEntitySheet(entity) {
  var name = SHEET_NAMES[entity];
  if (!name) return null;
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

function getHeaders(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  return data[0].map(String);
}

function writeHeaders(sheet, rec) {
  var headers = Object.keys(rec);
  sheet.clearContents();
  sheet.appendRow(headers);
}

function appendRow(sheet, headers, rec) {
  var row = headers.map(function(h) {
    var v = rec[h];
    return (v !== null && v !== undefined && typeof v === 'object') ? JSON.stringify(v) : (v !== undefined ? v : '');
  });
  sheet.appendRow(row);
}

function updateRow(sheet, rowNum, headers, rec) {
  var row = headers.map(function(h) {
    var v = rec[h];
    return (v !== null && v !== undefined && typeof v === 'object') ? JSON.stringify(v) : (v !== undefined ? v : '');
  });
  sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
}

function jsonResp(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}