use std::collections::HashSet;

use crate::activity::{activity_iso_from_ms, parse_activity_time_ms};
use crate::common::{affected_count, delete_all_sql, normalize_text, row_i64, ParamsBuilder};
use crate::database::{DatabaseService, DatabaseWriteTransaction};
use crate::ownership::OwnerId;
use crate::profile_bio::apply_backfilled_profile_bio;
use crate::realtime::{ensure_realtime_tables, normalize_user_table_prefix};
use crate::Error;
use vrcx_0_contracts::feed_live::FeedLiveEntry;
use vrcx_0_contracts::profile_bio::RecordedProfileBio;

pub fn feed_avatar_purge(
    db: &DatabaseService,
    user_id: String,
    cutoff_date: Option<String>,
) -> Result<i64, Error> {
    let user_prefix = normalize_user_table_prefix(&user_id)?;
    ensure_realtime_tables(db, &user_prefix)?;
    if let Some(cutoff_date) = cutoff_date.filter(|value| !value.trim().is_empty()) {
        return db.execute_non_query(
            &feed_avatar_delete_before_sql(&user_prefix),
            &ParamsBuilder::new().set("cutoff", cutoff_date).build(),
        );
    }
    db.execute_non_query(
        &delete_all_sql(&format!("{user_prefix}_feed_avatar")),
        &Default::default(),
    )
}

pub(crate) fn feed_avatar_delete_before_sql(user_prefix: &str) -> String {
    format!(
        "DELETE FROM {user_prefix}_feed_avatar
         WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', @cutoff, '+1 day')
           AND julianday(created_at) < julianday(@cutoff)"
    )
}

const BACKFILL_DUPLICATE_WINDOW_SECS: i64 = 120;

#[derive(Debug, Default)]
pub struct BackfillWrites {
    rows: HashSet<(&'static str, i64)>,
}

pub fn insert_backfilled_feed(
    db: &DatabaseService,
    owner_user_id: &OwnerId,
    entries: &[FeedLiveEntry],
    profile_bios: &[RecordedProfileBio],
    written: &mut BackfillWrites,
) -> Result<u64, Error> {
    let owner_user_id = normalize_text(owner_user_id.as_str());
    if owner_user_id.is_empty() {
        return Err(Error::Database(
            "Feed backfill requires a current user id.".into(),
        ));
    }
    // Replayed offline-logger frames are an *observation* of the live feed, so
    // they have to obey the same election as live writes. Without this gate a
    // device that had already yielded still replayed its own frames, and every
    // event the collector recorded came back a second later as a second row:
    // `created_at` is part of the row identity, so nothing could merge them.
    if !vrcx_0_contracts::is_live_feed_collector() {
        return Ok(0);
    }
    let user_prefix =
        crate::profile_bio::ensure_profile_bio_table(db, &OwnerId::new(owner_user_id))?;
    ensure_realtime_tables(db, &user_prefix)?;
    let (inserted, rows) = db.write_transaction(|tx| {
        let mut new_entries = Vec::with_capacity(entries.len());
        for entry in entries {
            if let Some(table) = backfilled_entry_table_if_new(tx, &user_prefix, entry, written)? {
                new_entries.push((table, entry));
            }
        }
        let mut inserted = 0;
        let mut rows = Vec::with_capacity(new_entries.len());
        for (table, entry) in new_entries {
            inserted += insert_feed_entry(tx, &user_prefix, entry)?;
            let row_id = tx.execute("SELECT last_insert_rowid()", &Default::default())?;
            rows.push((table, row_id.first().map_or(0, |row| row_i64(row, 0))));
        }
        for profile_bio in profile_bios {
            if let Some(entry) = apply_backfilled_profile_bio(tx, &user_prefix, profile_bio)? {
                inserted += insert_feed_entry(tx, &user_prefix, &entry)?;
            }
        }
        Ok((inserted, rows))
    })?;
    written.rows.extend(rows);
    Ok(inserted)
}

/// Business columns that identify one feed event.
///
/// `created_at` (local detection time) and `time` (derived locally) are
/// deliberately excluded: every client stamps its own, so two clients observing
/// the same event differ in exactly those columns. Everything else participates,
/// including `previous_*` - without them "the same change written twice" and
/// "two genuinely different changes with the same outcome" look identical.
/// (Same trade-off as VRCX-Luo's cross-client precheck.)
fn feed_identity_columns(
    entry: &FeedLiveEntry,
) -> Option<(&'static str, Vec<(&'static str, String)>)> {
    let columns = |entry_type: Option<String>,
                   user_id: &str,
                   display_name: &str,
                   rest: Vec<(&'static str, String)>| {
        let mut out = vec![
            ("user_id", user_id.to_string()),
            ("display_name", display_name.to_string()),
        ];
        if let Some(entry_type) = entry_type {
            out.push(("type", entry_type));
        }
        out.extend(rest);
        out
    };
    Some(match entry {
        FeedLiveEntry::Gps {
            user_id,
            display_name,
            location,
            world_name,
            previous_location,
            group_name,
            ..
        } => (
            "feed_gps",
            columns(
                None,
                user_id,
                display_name,
                vec![
                    ("location", location.clone()),
                    ("world_name", world_name.clone()),
                    ("previous_location", previous_location.clone()),
                    ("group_name", group_name.clone()),
                ],
            ),
        ),
        FeedLiveEntry::Online {
            user_id,
            display_name,
            location,
            world_name,
            group_name,
            ..
        }
        | FeedLiveEntry::Offline {
            user_id,
            display_name,
            location,
            world_name,
            group_name,
            ..
        } => (
            "feed_online_offline",
            columns(
                Some(entry.entry_type().to_string()),
                user_id,
                display_name,
                vec![
                    ("location", location.clone()),
                    ("world_name", world_name.clone()),
                    ("group_name", group_name.clone()),
                ],
            ),
        ),
        FeedLiveEntry::Status {
            user_id,
            display_name,
            status,
            status_description,
            previous_status,
            previous_status_description,
            ..
        } => (
            "feed_status",
            columns(
                None,
                user_id,
                display_name,
                vec![
                    ("status", status.clone()),
                    ("status_description", status_description.clone()),
                    ("previous_status", previous_status.clone()),
                    (
                        "previous_status_description",
                        previous_status_description.clone(),
                    ),
                ],
            ),
        ),
        FeedLiveEntry::Bio {
            user_id,
            display_name,
            bio,
            previous_bio,
            ..
        } => (
            "feed_bio",
            columns(
                None,
                user_id,
                display_name,
                vec![("bio", bio.clone()), ("previous_bio", previous_bio.clone())],
            ),
        ),
        FeedLiveEntry::Avatar {
            user_id,
            display_name,
            owner_id,
            avatar_name,
            current_avatar_image_url,
            previous_current_avatar_image_url,
            ..
        } => (
            "feed_avatar",
            columns(
                None,
                user_id,
                display_name,
                vec![
                    ("owner_id", owner_id.clone()),
                    ("avatar_name", avatar_name.clone()),
                    ("current_avatar_image_url", current_avatar_image_url.clone()),
                    (
                        "previous_current_avatar_image_url",
                        previous_current_avatar_image_url.clone(),
                    ),
                ],
            ),
        ),
        _ => return None,
    })
}

/// Whether a row with this event's full content already exists within `window_secs`.
///
/// Used by the live write path: during a collector handover both devices can
/// observe the same event for a few seconds, and the losing one would otherwise
/// append an unmergeable duplicate. VRCX-Luo guards this with `SELECT ... FOR
/// UPDATE` inside a transaction because its clients share one database; ours
/// writes inside a single SQLite transaction, which serializes writers the same
/// way.
pub(crate) fn feed_recent_duplicate_exists(
    tx: &mut DatabaseWriteTransaction<'_>,
    user_prefix: &str,
    entry: &FeedLiveEntry,
    window_secs: i64,
) -> Result<bool, Error> {
    let Some((table, columns)) = feed_identity_columns(entry) else {
        return Ok(false);
    };
    let mut params = ParamsBuilder::new();
    let mut clauses = Vec::with_capacity(columns.len() + 1);
    for (name, value) in &columns {
        clauses.push(format!("{name} = @{name}"));
        params = params.set(*name, value.clone());
    }
    params = params
        .set("created_at", entry.created_at().to_string())
        .set("window", window_secs);
    let rows = tx.execute(
        &format!(
            "SELECT id FROM {user_prefix}_{table} WHERE {} AND ABS(julianday(created_at) - julianday(@created_at)) * 86400 <= @window LIMIT 1",
            clauses.join(" AND ")
        ),
        &params.build(),
    )?;
    Ok(!rows.is_empty())
}

fn backfilled_entry_table_if_new(
    tx: &mut DatabaseWriteTransaction<'_>,
    user_prefix: &str,
    entry: &FeedLiveEntry,
    written: &BackfillWrites,
) -> Result<Option<&'static str>, Error> {
    let Some((table, columns)) = feed_identity_columns(entry) else {
        return Ok(None);
    };
    // `backfill_nearby_ids_sql` already pins `user_id = @user_id`, so the
    // remaining identity columns form the `same_change` part.
    let same_change = columns
        .iter()
        .filter(|(name, _)| *name != "user_id")
        .map(|(name, _)| format!("{name} = @{name}"))
        .collect::<Vec<_>>()
        .join(" AND ");
    let mut params = ParamsBuilder::new();
    for (name, value) in &columns {
        params = params.set(*name, value.clone());
    }
    let mut params = params
        .set("created_at", entry.created_at().to_string())
        .set("window", BACKFILL_DUPLICATE_WINDOW_SECS);
    let created_ms = parse_activity_time_ms(entry.created_at());
    if let Some(created_ms) = created_ms {
        let margin_ms = (BACKFILL_DUPLICATE_WINDOW_SECS + 1) * 1000;
        params = params
            .set("created_from", activity_iso_from_ms(created_ms - margin_ms))
            .set("created_to", activity_iso_from_ms(created_ms + margin_ms));
    }
    let nearby = tx.execute(
        &backfill_nearby_ids_sql(user_prefix, table, &same_change, created_ms.is_some()),
        &params.build(),
    )?;
    let recorded_elsewhere = nearby
        .iter()
        .any(|row| !written.rows.contains(&(table, row_i64(row, 0))));
    Ok((!recorded_elsewhere).then_some(table))
}

pub(crate) fn backfill_nearby_ids_sql(
    user_prefix: &str,
    table: &str,
    same_change: &str,
    indexed: bool,
) -> String {
    let indexed_range = if indexed {
        "AND created_at BETWEEN @created_from AND @created_to"
    } else {
        ""
    };
    format!(
        "SELECT id FROM {user_prefix}_{table} WHERE user_id = @user_id AND {same_change}
         {indexed_range}
         AND ABS(julianday(created_at) - julianday(@created_at)) * 86400 <= @window"
    )
}

pub(crate) fn insert_feed_entry(
    tx: &mut DatabaseWriteTransaction<'_>,
    user_prefix: &str,
    entry: &FeedLiveEntry,
) -> Result<u64, Error> {
    let affected = match entry {
        FeedLiveEntry::Gps {
            created_at,
            user_id,
            display_name,
            location,
            world_name,
            previous_location,
            time,
            group_name,
            ..
        } => tx.execute_non_query(
            &format!("INSERT OR IGNORE INTO {user_prefix}_feed_gps (created_at, user_id, display_name, location, world_name, previous_location, time, group_name) VALUES (@created_at, @user_id, @display_name, @location, @world_name, @previous_location, @time, @group_name)"),
            &ParamsBuilder::new()
                .set("created_at", created_at.clone())
                .set("user_id", user_id.clone())
                .set("display_name", display_name.clone())
                .set("location", location.clone())
                .set("world_name", world_name.clone())
                .set("previous_location", previous_location.clone())
                .set("time", *time)
                .set("group_name", group_name.clone())
                .build(),
        )?,
        FeedLiveEntry::Online {
            created_at,
            user_id,
            display_name,
            location,
            world_name,
            group_name,
            time,
            ..
        }
        | FeedLiveEntry::Offline {
            created_at,
            user_id,
            display_name,
            location,
            world_name,
            group_name,
            time,
            ..
        } => tx.execute_non_query(
            &format!("INSERT OR IGNORE INTO {user_prefix}_feed_online_offline (created_at, user_id, display_name, type, location, world_name, time, group_name) VALUES (@created_at, @user_id, @display_name, @type, @location, @world_name, @time, @group_name)"),
            &ParamsBuilder::new()
                .set("created_at", created_at.clone())
                .set("user_id", user_id.clone())
                .set("display_name", display_name.clone())
                .set("type", entry.entry_type())
                .set("location", location.clone())
                .set("world_name", world_name.clone())
                .set("time", time.unwrap_or(0))
                .set("group_name", group_name.clone())
                .build(),
        )?,
        FeedLiveEntry::Status {
            created_at,
            user_id,
            display_name,
            status,
            status_description,
            previous_status,
            previous_status_description,
            ..
        } => tx.execute_non_query(
            &format!("INSERT OR IGNORE INTO {user_prefix}_feed_status (created_at, user_id, display_name, status, status_description, previous_status, previous_status_description) VALUES (@created_at, @user_id, @display_name, @status, @status_description, @previous_status, @previous_status_description)"),
            &ParamsBuilder::new()
                .set("created_at", created_at.clone())
                .set("user_id", user_id.clone())
                .set("display_name", display_name.clone())
                .set("status", status.clone())
                .set("status_description", status_description.clone())
                .set("previous_status", previous_status.clone())
                .set("previous_status_description", previous_status_description.clone())
                .build(),
        )?,
        FeedLiveEntry::Bio {
            created_at,
            user_id,
            display_name,
            bio,
            previous_bio,
            ..
        } => tx.execute_non_query(
            &format!("INSERT OR IGNORE INTO {user_prefix}_feed_bio (created_at, user_id, display_name, bio, previous_bio) VALUES (@created_at, @user_id, @display_name, @bio, @previous_bio)"),
            &ParamsBuilder::new()
                .set("created_at", created_at.clone())
                .set("user_id", user_id.clone())
                .set("display_name", display_name.clone())
                .set("bio", bio.clone())
                .set("previous_bio", previous_bio.clone())
                .build(),
        )?,
        FeedLiveEntry::Avatar {
            created_at,
            user_id,
            display_name,
            owner_id,
            avatar_name,
            current_avatar_image_url,
            previous_current_avatar_image_url,
            ..
        } => tx.execute_non_query(
            &format!("INSERT OR IGNORE INTO {user_prefix}_feed_avatar (created_at, user_id, display_name, owner_id, avatar_name, current_avatar_image_url, previous_current_avatar_image_url) VALUES (@created_at, @user_id, @display_name, @owner_id, @avatar_name, @current_avatar_image_url, @previous_current_avatar_image_url)"),
            &ParamsBuilder::new()
                .set("created_at", created_at.clone())
                .set("user_id", user_id.clone())
                .set("display_name", display_name.clone())
                .set("owner_id", owner_id.clone())
                .set("avatar_name", avatar_name.clone())
                .set("current_avatar_image_url", current_avatar_image_url.clone())
                .set("previous_current_avatar_image_url", previous_current_avatar_image_url.clone())
                .build(),
        )?,
        FeedLiveEntry::DisplayName { .. }
        | FeedLiveEntry::TrustLevel { .. }
        | FeedLiveEntry::Friend { .. }
        | FeedLiveEntry::Unfriend { .. } => return Ok(0),
        FeedLiveEntry::OnPlayerJoining { .. } | FeedLiveEntry::InstanceClosed { .. } => {
            return Err(Error::InvalidData(format!(
                "Unknown realtime feed entry type: {}",
                entry.entry_type()
            )));
        }
    };
    Ok(affected_count(affected))
}
