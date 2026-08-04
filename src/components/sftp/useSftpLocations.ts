import { useCallback, useEffect, useRef, useState } from "react";
import { Message } from "@arco-design/web-react";
import {
  loadConfiguration,
  MAX_SFTP_PATH_HISTORY,
  upsertSftpLocation,
} from "../../config-database";
import type { SftpLocationRecord } from "../../models";
import { addRemotePathHistory } from "../../sftp-utils";

const EMPTY_SFTP_LOCATION: SftpLocationRecord = {
  hostId: "",
  bookmarks: [],
  history: [],
};

function samePaths(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

export default function useSftpLocations() {
  const [locations, setLocations] = useState<
    Record<string, SftpLocationRecord>
  >({});
  const locationsRef = useRef(locations);
  const persistenceErrorRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    void loadConfiguration()
      .then((configuration) => {
        if (disposed) return;
        const persisted = Object.fromEntries(
          configuration.sftpLocations.map((location) => [
            location.hostId,
            location,
          ]),
        );
        const merged = { ...persisted, ...locationsRef.current };
        locationsRef.current = merged;
        setLocations(merged);
      })
      .catch(() => {
        if (!disposed) Message.warning("无法读取 SFTP 目录记录");
      });
    return () => {
      disposed = true;
    };
  }, []);

  const commitLocation = useCallback(
    (
      hostId: string,
      update: (current: SftpLocationRecord) => SftpLocationRecord,
    ) => {
      const current = locationsRef.current[hostId] ?? {
        ...EMPTY_SFTP_LOCATION,
        hostId,
      };
      const next = update(current);
      if (
        samePaths(current.bookmarks, next.bookmarks) &&
        samePaths(current.history, next.history)
      ) {
        return;
      }
      const updated = { ...locationsRef.current, [hostId]: next };
      locationsRef.current = updated;
      setLocations(updated);
      void upsertSftpLocation(next)
        .then(() => {
          persistenceErrorRef.current = false;
        })
        .catch(() => {
          if (persistenceErrorRef.current) return;
          persistenceErrorRef.current = true;
          Message.warning("SFTP 目录记录保存失败");
        });
    },
    [],
  );

  const recordVisitedPath = useCallback(
    (hostId: string, path: string) => {
      commitLocation(hostId, (current) => ({
        ...current,
        history: addRemotePathHistory(
          current.history,
          path,
          MAX_SFTP_PATH_HISTORY,
        ),
      }));
    },
    [commitLocation],
  );

  const locationForHost = useCallback(
    (hostId?: string) =>
      hostId
        ? (locations[hostId] ?? { ...EMPTY_SFTP_LOCATION, hostId })
        : EMPTY_SFTP_LOCATION,
    [locations],
  );

  return {
    commitLocation,
    locationForHost,
    recordVisitedPath,
  };
}
